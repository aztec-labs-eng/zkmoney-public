import { Modal } from "../../../ui/Modal"
import { Warning } from "../../../ui/Warning"
import { useState } from "react"
import { formatUnits, parseUnits, type Address, type Hex } from "viem"
import { Network } from "@obsidion/sdk"
import { WalletError } from "@obsidion/core/errors"
import { errorMessage } from "../../../errors/catalog"
import {
  admitDeposit,
  floorToTypeable,
  useStore,
  type DepositLanding,
  type UsdValuation,
} from "@obsidion/front-core"
import { CornerButton } from "../../../ui/flow/CornerButton/CornerButton"
import {
  amountError,
  chargedAmount,
  floorAtomic,
  floorTo,
  shortL1Addr,
  tokenFigure,
  usdFigure,
} from "../../../ui/format"
import { coinFigure, displayDecimals } from "../../../ui/coinDecimals"
import { fmt } from "../../../lib/fmt"
import copy from "../sendFromWallet.copy"
import sheetCopy from "./DepositFromWalletModal.copy"
import { CoinIcon } from "../../../ui/CoinIcon/CoinIcon"
import { AmountStep } from "../../../ui/flow/AmountStep/AmountStep"
import amountCopy from "../../../ui/flow/AmountStep/AmountStep.copy"
import { DepositReview } from "../DepositReview/DepositReview"
import { ScreeningNotice, useScreenedAddress } from "../../../ui/screening"
import { isDesktopL1SubmitActive } from "../../../platform/desktopBridge"
import { useCopy } from "../../../ui/hooks"
import { amountExceedsBalance } from "../l1DepositTokenBalance"
import type { useL1Wallet } from "../../../session/useL1Wallet"
import {
  settlementOf,
  useDepositTokens,
  type DepositTokenOption,
} from "../../sipa/loadDepositFacts"
import { useSession } from "../../../session/session"
import type { DepositStage } from "../sipaAddresses"
import type { DepositAddress } from "../../sipa/depositTarget"
import type { DepositTarget } from "../../sipa/depositTarget"
import { useL1TokenBalance } from "../useL1TokenBalance"
import { FundingCapacityPanel } from "../FundingCapacityPanel"
import { useFundingCapacity } from "../useFundingCapacity"
import { useWalletPromptStall } from "../../../session/walletPrompt"
import { WalletPromptNote } from "../WalletPromptNote/WalletPromptNote"
import { LimitNotice, usdFigureGrouped, type LimitProblem } from "../../limits/publicLimit"
import { WalletAboutLimitsSheet } from "../../limits/AboutLimitsSheet"
import { useRowTxAmountCap } from "../../token/useTxAmountCap"
import { useScreenFlow } from "../../../ui/useScreenFlow"
import type { FundStart } from "../depositStart"
import type { CarriedAmount } from "../DepositScreen/depositScreenTransition"
import { UNKNOWN_CAPACITY } from "../fundingPreflight"
import { openFundFlow, type FundInputs } from "./fundFromWalletFlow"
import type { FundNote } from "./fundFromWalletTransition"
import { selectFeeChanged, selectShortfall } from "../fundFromWalletView"

const STAGE_LABEL: Partial<Record<DepositStage, string>> = {
  "minting": sheetCopy.stages.minting,
  "sending": sheetCopy.stages.sending,
  "awaiting-browser": sheetCopy.stages["awaiting-browser"],
  "confirming": sheetCopy.stages.confirming,
  "done": sheetCopy.stages.done,
}

/** `chargedAmount` reversed: what lands when the wallet sends `sent`, fee included. */
export function receivedAmount(sent: string, fee: string, decimals: number): string | undefined {
  try {
    const atomic = parseUnits(sent.trim(), decimals) - parseUnits(fee, decimals)
    return formatUnits(atomic > 0n ? atomic : 0n, decimals)
  } catch {
    return undefined
  }
}

/**
 * Amount entry → ERC-20 transfer from the connected L1 wallet (or, on the desktop
 * launcher, a helper page in the user's default browser) to the generated deposit address. `onSent`
 * fires as soon as the transfer is broadcast, with what the caller needs to show the deposit's
 * progress before discovery fills its record; `onSendFailed` fires if it then fails to confirm.
 */
export interface SentDeposit {
  address: DepositAddress["address"]
  txHash: Hex
  /** Charged amount, display units of the sent token. */
  amount: string
  tokenSymbol: string
  tokenAddress: Address
  tokenDecimals: number
  walletName?: string
  walletAddress?: Hex
}

/** What a stopped send says, in the sheet's words. */
function noteText(note: FundNote, network: string): string {
  if ("code" in note) return errorMessage(new WalletError(note.code))
  if ("switchFailed" in note) return fmt(copy.progress.switchFailed, { network })
  return note.error.message
}

export function DepositFromWalletModal({
  l1,
  walletLabel,
  deposit,
  token,
  fee,
  target,
  minimum: minimumToReceive,
  valuation,
  onClose,
  onSent,
  onSendFailed,
  onSendUnresolved,
  onApproving,
  onNotApproved,
  onFeeChanged,
  onConfirmed,
  payee,
  fixedAmount,
  handle,
  minutes,
  carried: initial,
  onCarry,
  onChangeOrigin,
  onBack,
  onChangeWallet,
  start,
}: {
  l1: ReturnType<typeof useL1Wallet>
  /** Names the connected account in place of the wallet's own name, such as a saved wallet's. */
  walletLabel?: string
  deposit: DepositAddress
  /** The picked token; unset `address` means the manifest token. */
  token: DepositTokenOption
  /** Protocol fee in display units; the modal cannot submit until it is known. */
  fee?: string
  /** A target's address, such as a registration's: `fee` is the target's own, fixed, not re-read. */
  target?: DepositTarget["kind"]
  /** The least to receive, in display units, when the address needs more than the usual $1: a
   * target's floor less its fee and what it already holds. */
  minimum?: string
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
   * Runs before the desktop helper is approved to send, with the desktop submission id, and, for a payer, before the
   * browser wallet's prompt, with an id for that send. It must resolve once it has durably recorded that a send may
   * follow, or reject so nothing is approved.
   */
  onApproving: (submission: string) => Promise<void>
  /** The submission `onApproving` ran for ended before any approval: nothing was sent under it. */
  onNotApproved: (submission: string) => void
  /** The fee read for a send differed from `fee`; the caller reloads it. */
  onFeeChanged?: () => void
  /** The transfer confirmed on Ethereum. */
  onConfirmed?: () => void
  /** Set when paying someone else's address: names them, and nothing is recorded on this device. */
  payee?: string
  /** What the payee receives, display units: prefilled and fixed. */
  fixedAmount?: string
  /** This wallet's zk.money name, on the side the funds land. */
  handle?: string
  /** How long a deposit takes to reach the private balance, where known. */
  minutes?: number
  /** The amount typed on another sheet, which this one starts from. */
  carried?: CarriedAmount
  /** Keeps what is typed here for the next sheet. */
  onCarry?: (amount: CarriedAmount) => void
  /** Opens the flow's network and coin menu. */
  onChangeOrigin?: () => void
  /** Leaves the form for the step before this sheet. */
  onBack?: () => void
  /** Opens the flow's wallet picker from the From row. */
  onChangeWallet?: () => void
  /** Where it opens, in place of the form. */
  start?: FundStart
}) {
  // The picked token's row: its cap, its capacity bucket and the token it credits.
  const txAmountCap = useRowTxAmountCap(token.settlesIn)
  const depositTokens = useDepositTokens()
  const { page } = useSession()
  const { config } = page
  const isSandbox = config.network === Network.SANDBOX
  // The amount that lands, as typed or MAX; a typed From sets it instead.
  const [typed, setTyped] = useState(fixedAmount ?? (initial?.side === "to" ? initial.amount : ""))
  // Set when the From field was typed: what lands follows from it.
  const [sentText, setSentText] = useState(
    fixedAmount === undefined && initial?.side === "from" ? initial.amount : undefined,
  )
  // MAX sticks: the amount follows the balance and fee until it is edited.
  const [maxed, setMaxed] = useState(false)
  const [aboutLimits, setAboutLimits] = useState(false)
  const { copied, copy: copyText } = useCopy()
  // Desktop launcher: no wallet extension in its profile, the transfer is approved in the default
  // browser, so there is no connected account to screen or to check a balance against.
  const bridgeMode = isDesktopL1SubmitActive()
  const session = useSession()

  // Filled below once this render's figures are known: the flow reads it when Send is pressed.
  const inputs = {} as FundInputs
  const flow = useScreenFlow(inputs, (latest) =>
    openFundFlow(
      {
        l1Wallet: page.l1Wallet,
        walletPrompt: page.walletPrompt,
        pace: page.pace,
        now: page.now,
        chainId: config.l1ChainId,
        fundDeposit: session.fundDeposit,
        start,
        fee,
      },
      latest,
    ),
  )
  const s = useStore(flow.state)
  const { phase, stage, submitUrl } = s
  const account = phase === "depositing" && s.sendingFrom !== undefined ? s.sendingFrom : l1.account
  // Read through the app's own L1 node, so the wallet's current chain does not matter.
  const balance = useL1TokenBalance({ account, token: token.address })
  const { verdict, cleared, rescreen } = useScreenedAddress(account, "deposit")
  const stalled = useWalletPromptStall(phase === "depositing" && stage === "sending")

  // A fixed amount was checked where it was set; otherwise at least one whole coin.
  const one = parseUnits("1", token.decimals)
  const floor = minimumToReceive ? parseUnits(minimumToReceive, token.decimals) : 0n
  const minimumAtomic = fixedAmount ? 0n : floor > one ? floor : one
  const minimum = formatUnits(minimumAtomic, token.decimals)
  // ponytail: sandbox always mints from the token's open faucet, so any connected account can deposit.
  const ceiling = selectShortfall(s, balance) ?? balance
  const feeAtomic = fee != null ? parseUnits(fee, token.decimals) : undefined
  const landing: DepositLanding | undefined =
    feeAtomic !== undefined
      ? { token, depositFeeAtomic: feeAtomic, txAmountCap, minimumAtomic }
      : undefined
  // The typed amount is what lands less the fee; the wallet sends exactly what lands.
  const admit = (receiveAtomic: bigint) => {
    if (!landing || feeAtomic === undefined) return undefined
    const sendAtomic = receiveAtomic + feeAtomic
    const admission = admitDeposit(landing, {
      landedAtomic: sendAtomic,
      gross: { atomic: sendAtomic, decimals: token.decimals, valuation },
    })
    return { sendAtomic, admission }
  }
  // The most that may land, less the fee: the largest amount to receive within both limits.
  const maxLanded = admit(0n)?.admission.maxLandedAtomic
  const maxReceiveAtomic =
    maxLanded !== undefined && feeAtomic !== undefined
      ? maxLanded > feeAtomic
        ? floorToTypeable(maxLanded - feeAtomic, token.decimals)
        : 0n
      : undefined
  // The most the wallet can deposit: its exact balance less the fee, within the published limit.
  const maxToReceive = (() => {
    if (isSandbox || bridgeMode || fixedAmount || !ceiling || feeAtomic === undefined)
      return undefined
    const spendable = ceiling.raw > feeAtomic ? ceiling.raw - feeAtomic : 0n
    const atomic =
      maxReceiveAtomic !== undefined && maxReceiveAtomic < spendable ? maxReceiveAtomic : spendable
    return atomic > 0n ? formatUnits(atomic, token.decimals) : undefined
  })()
  // A typed From amount sets what lands, at the current fee.
  const received =
    sentText === undefined
      ? undefined
      : sentText && fee != null
      ? receivedAmount(sentText, fee, token.decimals) ?? ""
      : ""
  const amount =
    maxed && maxToReceive !== undefined ? maxToReceive : received !== undefined ? received : typed
  // Any precision the token has: a MAX balance keeps its dust.
  const amountOk = !!amount && !amountError(amount, token.decimals)
  const amountAtomic = amountOk ? parseUnits(amount, token.decimals) : undefined
  const limits = amountAtomic !== undefined ? admit(amountAtomic) : undefined
  const admitted = limits?.admission
  const problem: LimitProblem | undefined = !valuation
    ? "valuation"
    : admitted?.problem === "minimum"
    ? undefined
    : admitted?.problem
  const maximum =
    maxReceiveAtomic !== undefined ? formatUnits(maxReceiveAtomic, token.decimals) : undefined
  const belowMinimum = admitted?.problem === "minimum"
  const valid = !!limits && !limits.admission.problem
  const charged = valid ? formatUnits(limits.sendAtomic, token.decimals) : undefined
  const overspent =
    !isSandbox && !bridgeMode && !!charged && !!ceiling && amountExceedsBalance(charged, ceiling)
  const gatesPass = !!charged && !overspent && (bridgeMode || (cleared && !l1.wrongChain))

  // Shared capacity meters the portal credit, which equals the entered amount only on the settlement-token route.
  const exactCredit = !token.swapped
  // Capacity is metered in the row's token: the picked one on the exact route.
  const settlement = depositTokens ? settlementOf(depositTokens, token) : token
  const capacitySymbol = exactCredit ? token.symbol : settlement.symbol
  const capacitySource = { kind: "active", token: token.settlesIn } as const
  const capacity = useFundingCapacity({
    rowToken: token.settlesIn,
    amountAtomic,
    decimals: token.decimals,
    exactCredit,
    mode: "editable",
    symbol: capacitySymbol,
    sentSymbol: token.symbol,
    minimumAtomic,
    unknownCapacity: UNKNOWN_CAPACITY,
  })
  const canSubmit = gatesPass && capacity.view.canFund
  // Everything but the wallet's chain, which the send switches first.
  const canStart =
    !!charged &&
    !overspent &&
    (bridgeMode || cleared) &&
    capacity.view.canFund &&
    (bridgeMode || !!l1.account)
  const network = isSandbox ? sheetCopy.sandboxNetwork : config.l1Chain.name
  // A capacity hold is said once, by the capacity line.
  const actionReason =
    (gatesPass && !capacity.view.canFund ? undefined : s.note && noteText(s.note, network)) ??
    (selectFeeChanged(s, fee) ? copy.progress.feeChanged : undefined)
  const latest: FundInputs = {
    canSubmit,
    wrongChain: !bridgeMode && l1.wrongChain,
    transfer:
      charged && amountAtomic !== undefined && admitted
        ? { charged, amountAtomic, admission: admitted }
        : undefined,
    account: l1.account,
    walletName: l1.walletName,
    balance,
    deposit,
    token,
    fee,
    target,
    payee,
    mint: isSandbox && !bridgeMode,
    capacity: capacity.store,
    onApproving,
    onNotApproved,
    onSent,
    onSendFailed,
    onSendUnresolved,
    onFeeChanged,
    onConfirmed,
  }
  Object.assign(inputs, latest)
  const carry = (next: CarriedAmount) => {
    if (fixedAmount === undefined) onCarry?.(next)
  }
  const enterAmount = (next: string) => {
    flow.typed()
    setMaxed(false)
    setSentText(undefined)
    setTyped(next)
    carry({ amount: next, side: "to" })
  }
  const enterSent = (next: string) => {
    flow.typed()
    setMaxed(false)
    setSentText(next)
    carry({ amount: next, side: "from" })
  }

  // No dismissing mid-transfer: the address is single-use and a second sheet could fund it twice.
  const dismiss = () => {
    if (phase !== "depositing") onClose()
  }
  // Back on every step but the transfer itself.
  const back = phase === "form" ? onBack : phase === "ready" ? flow.back : undefined
  const busy = phase === "switching" || phase === "switched" || phase === "depositing"

  const from = bridgeMode
    ? copy.browserWallet
    : account
    ? fmt(copy.from, {
        wallet: l1.walletName ?? copy.walletFallback,
        address: shortL1Addr(account),
      })
    : copy.noWallet
  // A wallet that left mid-sheet: connect one here and carry on.
  const fromPick = bridgeMode
    ? undefined
    : account
    ? onChangeWallet && { testId: "fund-change-wallet", onPick: onChangeWallet }
    : { testId: "fund-connect-wallet", onPick: () => void l1.connect() }
  // What leaves the wallet: the typed amount plus the fee.
  const sends = fee != null && amount ? chargedAmount(amount, fee, token.decimals) : undefined
  const typedError = amountError(sentText ?? amount, token.decimals)
  const typedText = sentText ?? amount
  const typedAtomic = typedText && !typedError ? parseUnits(typedText, token.decimals) : 0n
  const typedAny = typedAtomic > 0n
  const places = displayDecimals(token.symbol)
  // A figure the sheet derived, or MAX, shows the coin's display decimals; the amount behind it is
  // exact. Typed text shows as typed.
  const floored = (text: string | undefined) =>
    text ? floorTo(parseUnits(text, token.decimals), token.decimals, places) : text
  const swapped = capacitySymbol !== token.symbol
  const browserNote = stage === "awaiting-browser" && submitUrl && (
    <p className="ww-deposit__note">
      {copy.browserOpened} <code>{submitUrl}</code> —{" "}
      <button
        type="button"
        className="zkm-btn-reset ww-deposit__link"
        onClick={() => copyText(submitUrl)}
      >
        {copied ? copy.browserCopied : copy.browserCopyLink}
      </button>{" "}
      {copy.browserOpenedEnd}
    </p>
  )
  const toName = payee ? `@${payee}` : handle ? fmt(copy.to, { handle }) : copy.toFallback
  const title = !payee
    ? copy.title
    : fixedAmount
    ? fmt(copy.payTitleAmount, { amount: tokenFigure(fixedAmount, token.symbol), payee })
    : fmt(copy.payTitle, { payee })

  const actionNote = actionReason && !busy && (
    <p className="ww-capacity__reason" data-testid="funding-action-reason">
      {actionReason}
    </p>
  )
  // A typed send that the fee would take whole.
  const belowFee =
    sentText !== undefined &&
    typedAny &&
    fee != null &&
    parseUnits(sentText, token.decimals) <= parseUnits(fee, token.decimals)
  const showBalance = !bridgeMode && !!account
  const formView = (
    <AmountStep
      title={title}
      pill={
        account && !bridgeMode
          ? {
              name: walletLabel ?? l1.walletName ?? copy.walletFallback,
              address: shortL1Addr(account),
            }
          : undefined
      }
      subtitle={from}
      send={{
        testId: "fund-from",
        who: !bridgeMode && !account ? copy.connect : from,
        onPickWho: fromPick?.onPick,
        whoTestId: fromPick?.testId,
        value: sentText ?? floored(sends) ?? "",
        onChange: fixedAmount ? undefined : enterSent,
        balance: showBalance
          ? {
              figure: coinFigure(
                ceiling ? floorAtomic(ceiling.raw, ceiling.decimals, places) : 0n,
                ceiling?.decimals ?? token.decimals,
                token.symbol,
              ),
              loading: !ceiling,
            }
          : undefined,
        max:
          showBalance && !fixedAmount
            ? {
                disabled: !maxToReceive,
                onClick: () => {
                  if (!maxToReceive) return
                  enterAmount(maxToReceive)
                  setMaxed(true)
                },
              }
            : undefined,
        asset: {
          icon: <CoinIcon token={token} size={32} />,
          symbol: token.symbol,
          chain: config.l1Chain.name,
          onPick: onChangeOrigin,
        },
      }}
      receive={{
        testId: "fund-to",
        who: toName,
        value: (sentText !== undefined || maxed ? floored(amount) : amount) ?? "",
        onChange: fixedAmount ? undefined : enterAmount,
        // Unswapped, what lands is the send less the fee, exactly.
        approx: sentText !== undefined && swapped,
        fee: !typedAny ? "none" : fee != null ? { figure: usdFigure(fee) } : "unknown",
        feeTestId: "fund-fee",
        asset: {
          icon: <CoinIcon token={settlement} size={32} />,
          symbol: capacitySymbol,
          chain: config.l1Chain.name,
        },
      }}
      errors={overspent ? [copy.overspent] : typedError ? [typedError] : []}
      disabledHint={
        belowFee
          ? fmt(amountCopy.belowFee, { fee: usdFigure(fee!) })
          : belowMinimum
          ? fmt(copy.belowMinimum, { min: usdFigureGrouped(minimum) })
          : undefined
      }
      notices={
        <>
          {problem && (problem === "valuation" || amount) && (
            <LimitNotice
              operation="deposit"
              problem={problem}
              maximum={problem === "public" && maximum ? usdFigureGrouped(maximum) : undefined}
              onUseMaximum={maximum && !fixedAmount ? () => enterAmount(maximum) : undefined}
              onAboutLimits={() => setAboutLimits(true)}
            />
          )}
          <FundingCapacityPanel
            view={capacity.view}
            onRetry={capacity.retry}
            onUseAvailable={fixedAmount ? undefined : enterAmount}
            onAboutLimits={() => setAboutLimits(true)}
          />
          {account && !cleared && (
            <ScreeningNotice
              verdict={verdict}
              checkingCopy={copy.checkingWallet}
              blockedFallback={copy.walletBlocked}
              errorCopy={copy.walletUnverified}
              onRetry={rescreen}
            />
          )}
          {actionNote}
        </>
      }
      button={{ title: copy.review, disabled: !canStart, onClick: () => flow.review(fee) }}
    />
  )
  const sending = charged ?? sends ?? "0"
  const reviewView = (
    <DepositReview
      icon={<CoinIcon token={token} />}
      title={title}
      from={from}
      to={toName}
      toDetail={!payee && handle ? copy.toFallback : undefined}
      token={[
        { label: token.symbol, icon: <CoinIcon token={token} size={16} badge={false} /> },
        ...(swapped
          ? [
              {
                label: capacitySymbol,
                icon: <CoinIcon token={settlement} size={16} badge={false} />,
              },
            ]
          : []),
      ]}
      send={tokenFigure(sending, token.symbol)}
      receive={tokenFigure(amount, capacitySymbol)}
      feeUsd={fee != null ? usdFigure(fee) : "--"}
      totalUsd={usdFigure(sending)}
      network={{ hops: [config.l1Chain.name], arrivesInMinutes: minutes }}
      callout={
        phase === "depositing"
          ? stage && STAGE_LABEL[stage]
          : phase === "switching" || phase === "switched"
          ? fmt(copy.progress.switchChain, { network })
          : undefined
      }
      notices={
        <>
          {browserNote}
          {actionReason && !busy && <Warning title={actionReason} testId="funding-action-reason" />}
        </>
      }
      button={{
        title: payee ? copy.payButton : fmt(copy.send, { coin: token.symbol }),
        loading: busy,
        disabled: !canStart,
        onClick: () => void flow.send(),
      }}
    />
  )

  return (
    <Modal
      variant="bare"
      label={copy.title}
      className="ww-deposit-warning ww-deposit-sheet ww-bridge-sheet"
      step={phase === "form" ? "form" : "review"}
      stepDepth={phase === "form" ? 0 : 1}
      onClose={phase === "depositing" ? undefined : onClose}
    >
      {back && (
        <div className="ww-deposit-warning__back">
          <CornerButton kind="back" onClick={back} />
        </div>
      )}
      <div className="ww-deposit-warning__close">
        <CornerButton kind="close" onClick={dismiss} />
      </div>
      {phase === "form" ? formView : reviewView}
      {stalled && <WalletPromptNote walletName={l1.walletName} onCancel={flow.cancelPrompt} />}
      {aboutLimits && (
        <WalletAboutLimitsSheet
          topic="capacity"
          capacity={capacitySource}
          settlementSymbol={capacitySymbol}
          onClose={() => setAboutLimits(false)}
        />
      )}
    </Modal>
  )
}
