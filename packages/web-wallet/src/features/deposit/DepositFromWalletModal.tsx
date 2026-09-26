import { Modal } from "../../ui/Modal"
import { useState } from "react"
import { formatUnits, parseUnits, type Hex } from "viem"
import { Network, TX_AMOUNT_CAP } from "@obsidion/sdk"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { GradientText, Icon, PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"
import { getConfig } from "../../config/env"
import { showReportableError } from "../../errors/errorModal"
import { amountBucket, failureCode, fireEvent, lapTimer } from "../../lib/analytics"
import { amountError, decimalInput, parseAmount, shortAddr, usdFigure } from "../../ui/format"
import { ScreeningNotice, useScreenedAddress } from "../../ui/screening"
import { isDesktopL1SubmitActive } from "../../platform/desktopBridge"
import { useCopy } from "../../ui/hooks"
import {
  amountExceedsBalance,
  InsufficientL1BalanceError,
  type L1TokenBalance,
} from "./l1DepositTokenBalance"
import { isWalletRejection, type useL1Wallet } from "./l1Wallet"
import type { DepositTokenOption } from "./loadDepositFacts"
import { getSipaDepositGateway, type DepositAddress, type DepositStage } from "./sipaGateway"
import ethIcon from "../../assets/deposit/ethereum.webp"
import { useL1TokenBalance } from "./useL1TokenBalance"

const STAGE_LABEL: Partial<Record<DepositStage, string>> = {
  "connecting": "Connecting your wallet",
  "minting": "Minting test tokens",
  "sending": "Approve the transfer in your wallet",
  "awaiting-browser": "Approve the transfer in your browser",
  "confirming": "Waiting for L1 confirmation",
  "done": "Done",
}

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
  onClose,
  onSent,
  onSendFailed,
}: {
  l1: ReturnType<typeof useL1Wallet>
  deposit: DepositAddress
  /** The picked token; unset `address` means the manifest token. */
  token: DepositTokenOption
  /** Protocol fee in display units; the modal cannot submit until it is known. */
  fee?: string
  onClose: () => void
  onSent: (sent: SentDeposit) => void
  onSendFailed: () => void
}) {
  const config = getConfig()
  const isSandbox = config.network === Network.SANDBOX
  const [amount, setAmount] = useState("")
  const [phase, setPhase] = useState<"form" | "confirm" | "depositing">("form")
  const [stage, setStage] = useState<DepositStage>()
  // Wallet balance reported by a rejected transfer; fresher than the mount-time read.
  const [shortfall, setShortfall] = useState<L1TokenBalance>()
  const [submitUrl, setSubmitUrl] = useState<string>()
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

  const parsed = parseAmount(amount)
  const minimum = 1
  // The cap meters what the portal credits, which is the typed amount.
  const maximum = Number(formatUnits(TX_AMOUNT_CAP, DEFAULT_DECIMALS))
  const overCap = Number.isFinite(parsed) && parsed > maximum
  const valid = Number.isFinite(parsed) && parsed >= minimum && !overCap
  // The typed amount is what lands; the wallet is charged that plus the fee.
  const charged = valid && fee != null ? chargedAmount(amount, fee, token.decimals) : undefined
  // ponytail: sandbox always mints (TestERC20 faucet); the deployer account must be the one connected.
  const ceiling = shortfall ?? balance
  const overspent =
    !isSandbox && !bridgeMode && !!charged && !!ceiling && amountExceedsBalance(charged, ceiling)
  const canSubmit = !!charged && !overspent && (bridgeMode || (cleared && !l1.wrongChain))

  const run = async () => {
    if (!canSubmit) return
    setPhase("depositing")
    setSubmitUrl(undefined)
    const elapsed = lapTimer()
    // Once the transfer is broadcast the caller owns the UI; this modal is gone.
    let submitted = false
    try {
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
        onSubmitted: (txHash) => {
          submitted = true
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
      if (!submitted && isWalletRejection(e)) {
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
      setPhase("confirm")
      showReportableError(e, "deposit:send")
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
        <span>Sent</span>
        <b>{charged ? usdFigure(charged) : "$--"}</b>
      </div>
      <div className="ww-deposit__fact">
        <span>Fee</span>
        <b>{fee != null ? usdFigure(fee) : "—"}</b>
      </div>
      <hr className="ww-divider" />
      <div className="ww-deposit__fact">
        <span>Received</span>
        <b>{valid ? usdFigure(amount) : "$--"}</b>
      </div>
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
        onClick={run}
        style={{ width: "100%", height: 48 }}
      />
    )

  return (
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
            <span className="ww-fund__label">Amount</span>
            <label className="ww-deposit__input ww-fund__amount">
              <span>
                <input
                  aria-label="Amount"
                  inputMode="decimal"
                  placeholder={`Minimum ${usdFigure(String(minimum))}`}
                  value={amount}
                  onChange={(e) => setAmount(decimalInput(e.target.value))}
                />
                <small>
                  {overspent
                    ? `Not enough funds — your wallet holds ${ceiling!.display}`
                    : overCap
                    ? `Deposit up to ${usdFigure(String(maximum))} at a time`
                    : amountError(amount) ?? `$${valid ? parsed : 0}`}
                </small>
              </span>
              <span className="ww-deposit__pill">
                <img src={token.icon} alt="" width={16} height={16} />
                {token.symbol}
              </span>
            </label>
            <div className="ww-deposit__facts">{breakdown}</div>
            {l1.account && !cleared && (
              <ScreeningNotice
                verdict={verdict}
                checkingCopy="Checking your wallet…"
                blockedFallback="This wallet can't be used to deposit. Connect a different one."
                errorCopy="Couldn't verify your wallet."
                onRetry={rescreen}
              />
            )}
          </div>
        </>
      ) : (
        <>
          <div>
            <GradientText size={32} weight={700}>
              {usdFigure(amount)}
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
      {button}
    </Modal>
  )
}
