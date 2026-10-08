import { Modal } from "../../ui/Modal"
import { useState } from "react"
import { formatUnits, parseUnits, type Hex } from "viem"
import { Network } from "@obsidion/sdk"
import { depositLimits, type UsdValuation } from "@obsidion/front-core"
import { GradientText, Icon, PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"
import { getConfig } from "../../config/env"
import { showReportableError } from "../../errors/errorModal"
import { amountBucket, failureCode, fireEvent, lapTimer } from "../../lib/analytics"
import { amountError, decimalInput, parseAmount, shortAddr } from "../../ui/format"
import { ScreeningNotice, useScreenedAddress } from "../../ui/screening"
import {
  DesktopBridgeUpdateRequiredError,
  DesktopRecheckTimeoutError,
  DesktopSendOpenError,
  DesktopSendUnresolvedError,
  isDesktopL1SubmitActive,
} from "../../platform/desktopBridge"
import { useCopy } from "../../ui/hooks"
import {
  amountExceedsBalance,
  InsufficientL1BalanceError,
  type L1TokenBalance,
} from "./l1DepositTokenBalance"
import { isWalletRejection, type useL1Wallet } from "./l1Wallet"
import { depositTokensFor, type DepositTokenOption } from "./loadDepositFacts"
import { getSipaDepositGateway, type DepositAddress, type DepositStage } from "./sipaGateway"
import ethIcon from "../../assets/deposit/ethereum.webp"
import { useL1TokenBalance } from "./useL1TokenBalance"
import { FundingCapacityPanel } from "./FundingCapacityPanel"
import type { UnknownCapacityPolicy } from "./fundingCapacity"
import { FundingPreflightError, runFundingPreflight } from "./fundingPreflight"
import { useFundingCapacity } from "./useFundingCapacity"
import { UnresolvedSendHeldError, UnresolvedSendStorageError } from "./unresolvedSend"
import {
  useWalletPrompt,
  useWalletPromptStall,
  WalletPromptNote,
  WalletPromptOpenError,
  type WalletPromptToken,
} from "./walletPrompt"
import {
  LimitNotice,
  OperationLimits,
  usdFigureGrouped,
  type LimitProblem,
} from "../limits/publicLimit"
import { LimitsInfoButton, WalletAboutLimitsSheet } from "../limits/AboutLimitsSheet"

const STAGE_LABEL: Partial<Record<DepositStage, string>> = {
  "connecting": "Connecting your wallet",
  "minting": "Minting test tokens",
  "sending": "Approve the transfer in your wallet",
  "awaiting-browser": "Approve the transfer in your browser",
  "confirming": "Waiting for Ethereum confirmation",
  "done": "Done",
}

/** Only capacity known not to take the deposit holds it: an unread bucket or an unknown conversion credit does not. */
const UNKNOWN_CAPACITY: UnknownCapacityPolicy = "proceed"

/** Wallet-side amount: what the user wants to land plus the fee, decimal-safe. */
export function chargedAmount(amount: string, fee: string, decimals: number): string | undefined {
  try {
    return formatUnits(parseUnits(amount.trim(), decimals) + parseUnits(fee, decimals), decimals)
  } catch {
    return undefined
  }
}

/**
 * Amount entry → confirmation → ERC-20 transfer from the connected L1 wallet (or, on the desktop
 * launcher, a helper page in the user's default browser) to the generated deposit address. `onSent`
 * fires as soon as the transfer is broadcast, with what the caller needs to show the deposit's
 * progress before the store has a record for it; `onSendFailed` fires if it then fails to confirm.
 */
export interface SentDeposit {
  address: DepositAddress["address"]
  txHash: Hex
  /** Charged amount, display units. */
  amount: string
  tokenSymbol: string
  walletName?: string
  walletAddress?: Hex
}

export function DepositFromWalletModal({
  l1,
  deposit,
  token,
  fee,
  valuation,
  onClose,
  onSent,
  onSendFailed,
  onSendUnresolved,
  onApproving,
  onNotApproved,
  onFeeChanged,
}: {
  l1: ReturnType<typeof useL1Wallet>
  deposit: DepositAddress
  /** The picked token; unset `address` means the manifest token. */
  token: DepositTokenOption
  /** Protocol fee in display units; the modal cannot submit until it is known. */
  fee?: string
  /** Prices `token` for the published limit; nothing can be sent without it. */
  valuation?: UsdValuation
  onClose: () => void
  onSent: (sent: SentDeposit) => void
  onSendFailed: () => void
  /**
   * The desktop helper was approved to send but no hash arrived: the address may be funded, so it must not be
   * offered again and nothing may say the transfer did not happen.
   */
  onSendUnresolved: () => void
  /**
   * Runs before the desktop helper is approved to send, with the desktop submission id; it must resolve once it has
   * durably recorded that a send may follow, or reject so nothing is approved.
   */
  onApproving: (submission: string) => Promise<void>
  /** The desktop submission `onApproving` ran for ended before any approval: nothing was sent under it. */
  onNotApproved: (submission: string) => void
  /** The fee read for a send differed from `fee`; the caller reloads it. */
  onFeeChanged?: () => void
}) {
  const config = getConfig()
  const isSandbox = config.network === Network.SANDBOX
  const [amount, setAmount] = useState("")
  const [phase, setPhase] = useState<"form" | "confirm" | "depositing">("form")
  const [stage, setStage] = useState<DepositStage>()
  // Wallet balance reported by a rejected transfer; fresher than the mount-time read.
  const [shortfall, setShortfall] = useState<L1TokenBalance>()
  const [submitUrl, setSubmitUrl] = useState<string>()
  const [aboutLimits, setAboutLimits] = useState(false)
  // Why the last send stopped before any transfer, until the amount changes.
  const [preflightNote, setPreflightNote] = useState<string>()
  const { copied, copy } = useCopy()
  // Desktop launcher: no wallet extension in its profile, the transfer is approved in the default
  // browser, so there is no connected account to screen or to check a balance against.
  const bridgeMode = isDesktopL1SubmitActive()
  const balance = useL1TokenBalance({
    account: l1.account,
    wrongChain: l1.wrongChain,
    token: token.address,
  })
  const { verdict, cleared, rescreen } = useScreenedAddress(l1.account, "deposit")
  const prompt = useWalletPrompt()
  const stalled = useWalletPromptStall(phase === "depositing" && stage === "sending")
  // Back to the confirm step; the transfer the wallet still holds is handled when it answers.
  const cancelPrompt = () => {
    prompt.cancel()
    setStage(undefined)
    setPhase("confirm")
  }

  const parsed = parseAmount(amount)
  const minimum = 1
  // The typed amount is what lands; the wallet sends that plus the fee. The published limit counts
  // the send; the protocol ceiling counts the credit, which only the settlement token states up front.
  const limits =
    Number.isFinite(parsed) && fee != null
      ? depositLimits({
          receiveAtomic: parseUnits(amount, token.decimals),
          feeAtomic: parseUnits(fee, token.decimals),
          decimals: token.decimals,
          valuation,
          settlementCreditAtomic: token.address ? undefined : parseUnits(amount, token.decimals),
        })
      : undefined
  const problem: LimitProblem | undefined = !valuation
    ? "valuation"
    : limits?.publicLimit === "over"
    ? "public"
    : limits?.protocolCeiling === "over"
    ? "protocol"
    : undefined
  const maximum =
    limits?.maxReceiveAtomic !== undefined
      ? formatUnits(limits.maxReceiveAtomic, token.decimals)
      : undefined
  const valid = Number.isFinite(parsed) && parsed >= minimum && !!limits && !problem
  const charged = valid ? formatUnits(limits.sendAtomic, token.decimals) : undefined
  // ponytail: sandbox always mints (TestERC20 faucet); the deployer account must be the one connected.
  const ceiling = shortfall ?? balance
  const overspent =
    !isSandbox && !bridgeMode && !!charged && !!ceiling && amountExceedsBalance(charged, ceiling)
  const gatesPass = !!charged && !overspent && (bridgeMode || (cleared && !l1.wrongChain))

  // Shared capacity meters the portal credit, which equals the entered amount only on the settlement-token route.
  const exactCredit = !token.address
  // Capacity is metered in the settlement token: the picked one on the exact route.
  const capacitySymbol = exactCredit ? token.symbol : depositTokensFor(config.network)[0].symbol
  const capacity = useFundingCapacity({
    amountAtomic:
      Number.isFinite(parsed) && !amountError(amount)
        ? parseUnits(amount, token.decimals)
        : undefined,
    decimals: token.decimals,
    exactCredit,
    mode: "editable",
    symbol: capacitySymbol,
    sentSymbol: token.symbol,
    minimumAtomic: parseUnits(String(minimum), token.decimals),
    unknownCapacity: UNKNOWN_CAPACITY,
  })
  const canSubmit = gatesPass && capacity.view.canFund
  // A capacity hold is said once, by the capacity line.
  const actionReason = gatesPass && !capacity.view.canFund ? undefined : preflightNote
  const enterAmount = (next: string) => {
    setPreflightNote(undefined)
    setAmount(next)
  }

  const run = async () => {
    if (!canSubmit) return
    if (prompt.openElsewhere) {
      setPreflightNote(prompt.openElsewhere)
      return
    }
    setPhase("depositing")
    setSubmitUrl(undefined)
    const elapsed = lapTimer()
    // Once the transfer is broadcast the caller owns the UI; this modal is gone.
    let submitted = false
    let approving: string | undefined
    let request: WalletPromptToken | undefined
    const { store, required } = capacity
    try {
      request = prompt.begin()
      await getSipaDepositGateway().deposit({
        target: deposit,
        amountDisplay: charged!,
        from: l1.account ?? undefined,
        walletName: l1.walletName ?? undefined,
        tokenSymbol: token.symbol,
        token: token.address ? { address: token.address, decimals: token.decimals } : undefined,
        mint: isSandbox && !bridgeMode,
        onStage: setStage,
        onBrowserSubmit: setSubmitUrl,
        beforeApprove: (submission) => {
          approving = submission
          return onApproving(submission)
        },
        preflight: (fresh) =>
          runFundingPreflight({
            store,
            required,
            unknownCapacity: UNKNOWN_CAPACITY,
            shownFee: fee,
            freshFee: fresh.feeDisplay,
          }),
        onSubmitted: (txHash) => {
          submitted = true
          prompt.settle(request)
          onSent({
            address: deposit.address,
            txHash,
            amount: charged!,
            tokenSymbol: token.symbol,
            walletName: l1.walletName ?? undefined,
            walletAddress: l1.account ?? undefined,
          })
        },
      })
      fireEvent("deposit_funded", {
        duration_ms: elapsed(),
        funding: "wallet",
        amount_bucket: amountBucket(BigInt(Math.floor(parsed)), 0),
      })
    } catch (e) {
      if (e instanceof WalletPromptOpenError) {
        setPreflightNote(e.message)
        setPhase("confirm")
        return
      }
      if (approving && !submitted && !(e instanceof DesktopSendUnresolvedError)) {
        onNotApproved(approving)
      }
      if (!submitted && (prompt.cancelled(request) || isWalletRejection(e))) {
        setPhase("confirm")
        return
      }
      fireEvent("action_failed", { action: "deposit:send", code: failureCode(e) })
      if (submitted) {
        onSendFailed()
        showReportableError(e, "deposit:confirm")
        return
      }
      if (e instanceof InsufficientL1BalanceError) {
        setShortfall(e.balance)
        setPhase("form")
        return
      }
      // Stopped before any transfer: the form shows the new capacity and fee.
      if (
        e instanceof FundingPreflightError ||
        e instanceof DesktopRecheckTimeoutError ||
        e instanceof DesktopBridgeUpdateRequiredError ||
        e instanceof DesktopSendOpenError ||
        e instanceof UnresolvedSendStorageError ||
        e instanceof UnresolvedSendHeldError
      ) {
        if (e instanceof FundingPreflightError && e.reason === "quote-changed") onFeeChanged?.()
        setPreflightNote(e.message)
        setPhase("form")
        return
      }
      if (e instanceof DesktopSendUnresolvedError) {
        onSendUnresolved()
        return
      }
      setPhase("confirm")
      showReportableError(e, "deposit:send")
    } finally {
      prompt.settle(request)
    }
  }

  // No dismissing mid-transfer: the address is single-use and a second sheet could fund it twice.
  const dismiss = () => {
    if (phase !== "depositing") onClose()
  }

  const from = bridgeMode
    ? "Your browser wallet"
    : `${l1.walletName ?? "Wallet"} · ${l1.account ? shortAddr(l1.account) : ""}`
  const breakdown = (
    <>
      <div className="ww-deposit__fact">
        <span>You send</span>
        <b>{charged ? usdFigureGrouped(charged) : "$--"}</b>
      </div>
      <div className="ww-deposit__fact">
        <span>Fee</span>
        <b>{fee != null ? usdFigureGrouped(fee) : "—"}</b>
      </div>
      <hr className="ww-divider" />
      <div className="ww-deposit__fact">
        <span>You receive</span>
        <b>{valid ? usdFigureGrouped(amount) : "$--"}</b>
      </div>
      {token.address && (
        <p className="ww-limits__note">
          {token.symbol} is swapped to DAI at the market rate, so the DAI you receive can differ.
        </p>
      )}
    </>
  )
  const button =
    !bridgeMode && l1.wrongChain ? (
      <PrimaryGradientButton
        title={
          l1.connecting
            ? "Switching…"
            : `Switch to ${isSandbox ? "the sandbox network" : config.l1Chain.name}`
        }
        isLoading={l1.connecting}
        onClick={l1.switchNetwork}
        style={{ width: "100%", height: 48 }}
      />
    ) : phase === "form" ? (
      <PrimaryGradientButton
        title="Deposit funds"
        isDisabled={!canSubmit}
        onClick={() => setPhase("confirm")}
        style={{ width: "100%", height: 48 }}
      />
    ) : (
      <PrimaryGradientButton
        title={
          phase === "depositing"
            ? STAGE_LABEL[stage ?? "connecting"] ?? "Working…"
            : "Confirm deposit"
        }
        isLoading={phase === "depositing"}
        isDisabled={phase === "confirm" && !canSubmit}
        onClick={run}
        style={{ width: "100%", height: 48 }}
      />
    )

  return (
    <>
      <Modal
        variant="bare"
        label="Deposit from wallet"
        className="ww-deposit-warning ww-fund"
        onClose={phase === "depositing" ? undefined : onClose}
      >
        <div className="ww-deposit-warning__close">
          <TopNavIconButton icon="x" ariaLabel="Close" onClick={dismiss} />
        </div>
        <span className="ww-deposit__connect-icon">
          <Icon name="coins" size={24} color="#fff" />
        </span>

        {phase === "form" ? (
          <>
            <div>
              <GradientText size={24} weight={700}>
                Deposit from {bridgeMode ? "your browser" : l1.walletName ?? "wallet"}
              </GradientText>
              <div className="ww-fund__addr">{l1.account ? shortAddr(l1.account) : ""}</div>
            </div>
            <div className="ww-fund__fields">
              <span className="ww-fund__label">Amount to receive</span>
              <label className="ww-deposit__input ww-fund__amount">
                <span>
                  <input
                    aria-label="Amount to receive"
                    inputMode="decimal"
                    placeholder={`Minimum ${usdFigureGrouped(String(minimum))}`}
                    value={amount}
                    onChange={(e) => enterAmount(decimalInput(e.target.value))}
                  />
                  <small>
                    {overspent
                      ? `Not enough funds — your wallet holds ${ceiling!.display}`
                      : amountError(amount) ??
                        usdFigureGrouped(String(Number.isFinite(parsed) ? parsed : 0))}
                  </small>
                </span>
                <span className="ww-deposit__pill">
                  <img src={token.icon} alt="" width={16} height={16} />
                  {token.symbol}
                </span>
              </label>
              <OperationLimits
                operation="deposit"
                minimum={usdFigureGrouped(String(minimum))}
                info={
                  <LimitsInfoButton
                    topic="limit"
                    label="About the deposit limit"
                    capacity={{ kind: "active" }}
                    settlementSymbol={capacitySymbol}
                  />
                }
              />
              {problem && (problem === "valuation" || amount) && (
                <LimitNotice
                  operation="deposit"
                  problem={problem}
                  maximum={problem === "public" && maximum ? usdFigureGrouped(maximum) : undefined}
                  onUseMaximum={maximum ? () => enterAmount(maximum) : undefined}
                />
              )}
              <FundingCapacityPanel
                view={capacity.view}
                onRetry={capacity.retry}
                onUseAvailable={enterAmount}
                onAboutLimits={() => setAboutLimits(true)}
              />
              <div className="ww-deposit__facts">{breakdown}</div>
              {l1.account && !cleared && (
                <ScreeningNotice
                  verdict={verdict}
                  checkingCopy="Checking your wallet…"
                  blockedFallback="This wallet can't be used to deposit. Connect a different one."
                  errorCopy="Couldn't verify your wallet. Check your internet connection or try another wallet."
                  onRetry={rescreen}
                />
              )}
            </div>
          </>
        ) : (
          <>
            <div>
              <GradientText size={32} weight={700}>
                {usdFigureGrouped(amount)}
              </GradientText>
              <div className="ww-fund__addr">Deposit</div>
            </div>
            <div className="ww-fund__fields">
              <div className="ww-deposit__facts">
                <div className="ww-deposit__fact">
                  <span>From</span>
                  <b>{from}</b>
                </div>
                <div className="ww-deposit__fact">
                  <span>Token</span>
                  <b>
                    <img src={token.icon} alt="" width={16} height={16} />
                    {token.symbol}
                  </b>
                </div>
                <div className="ww-deposit__fact">
                  <span>Network</span>
                  <b>
                    <img src={ethIcon} alt="" width={16} height={16} />
                    Ethereum (ERC20)
                  </b>
                </div>
                {breakdown}
              </div>
              <FundingCapacityPanel
                view={capacity.view}
                onRetry={capacity.retry}
                onAboutLimits={() => setAboutLimits(true)}
              />
              {stage === "awaiting-browser" && submitUrl && (
                <p className="ww-deposit__note">
                  A page opened in your regular browser at <code>{submitUrl}</code> —{" "}
                  <button
                    type="button"
                    className="zkm-btn-reset ww-deposit__link"
                    onClick={() => copy(submitUrl)}
                  >
                    {copied ? "copied" : "copy link"}
                  </button>{" "}
                  and open it there yourself if nothing appeared.
                </p>
              )}
            </div>
          </>
        )}
        {actionReason && phase !== "depositing" && (
          <p className="ww-capacity__reason" data-testid="funding-action-reason">
            {actionReason}
          </p>
        )}
        {button}
        {stalled && <WalletPromptNote walletName={l1.walletName} onCancel={cancelPrompt} />}
      </Modal>
      {aboutLimits && (
        <WalletAboutLimitsSheet
          topic="capacity"
          capacity={{ kind: "active" }}
          settlementSymbol={capacitySymbol}
          onClose={() => setAboutLimits(false)}
        />
      )}
    </>
  )
}
