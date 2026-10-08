import { Modal } from "../../ui/Modal"
import { useRef, useState } from "react"
import { formatUnits, parseUnits, type Address, type Hex } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import {
  NOMINAL_USD_VALUATION,
  upsertSavedL1WalletContact,
  useAccountContext,
  useAssetContext,
  useAztecContext,
  useBalance,
  useContractServiceContext,
  withdrawalMaxNet,
} from "@obsidion/front-core"
import { isPasskeyCancelled } from "@obsidion/passkey-web"
import {
  AmountChipRow,
  GradientText,
  Icon,
  PrimaryGradientButton,
  TopNavIconButton,
} from "@obsidion/web-ds"
import { chargedAmount } from "../deposit/DepositFromWalletModal"
import { showReportableError } from "../../errors/errorModal"
import { amountBucket, failureCode, fireEvent, lapTimer } from "../../lib/analytics"
import { amountError, decimalInput, parseAmount, shortAddr, usdFigure } from "../../ui/format"
import { useProvingOutcome } from "../../ui/hooks"
import { DepositFact } from "../../ui/screens/DepositFact"
import { useUserFlowActive } from "../provingGate"
import { useBusyLabel } from "../operations/operations"
import { OperationHandOff } from "../operations/OperationHandOff"
import { ScreeningNotice, useScreenedAddress } from "../../ui/screening"
import { TeeSignerNotice } from "../../ui/TeeSignerNotice"
import { Warning } from "../../ui/Warning"
import { getConfig } from "../../config/env"
import {
  FEE_UNAVAILABLE_COPY,
  SwapFeeNote,
  settledFloor,
  useSwapSimulation,
  type WithdrawalQuoteState,
} from "./withdrawQuote"
import { networkHasSwapStack } from "./freshAddressAvailability"
import {
  freshLegBurnAmount,
  resumeFreshAddressFunds,
  submitFreshAddressWithdrawal,
  type FreshLeg,
  type FreshLegQuote,
  type FreshWithdrawStage,
} from "./freshAddressGateway"
import { AssetPicker } from "./WithdrawalAssetPicker"
import { estimateText, WithdrawReview } from "./WithdrawReview"
import { recordBurnDuration } from "./burnTiming"
import {
  BALANCE_TIP_BLOCKED_COPY,
  LIMIT_TIP_BLOCKED_COPY,
  SpeedRow,
  useSpeedChoice,
  useSpeedOutcome,
} from "./speedChoice"
import {
  WITHDRAWAL_RECEIVE_ASSETS,
  withdrawalReceiveAsset,
  type WithdrawalReceiveAsset,
} from "./withdrawAssets"
import { LimitLine, LimitNotice, usdFigureGrouped } from "../limits/publicLimit"
import { LimitsInfoButton } from "../limits/AboutLimitsSheet"
import { withdrawalLimitProblem } from "../limits/withdrawalLimit"

/** Dollars of the wallet asset that land as ETH, on top of the funds. $0 sends the funds alone. */
const GAS_CHIPS = [0, 1, 5, 10, 15]
const DEFAULT_GAS = 5

/** No gas leg, on a resume or at a $0 share; the gateway's input still names one. */
const NO_GAS_QUOTE: FreshLegQuote = { relayerTip: 0n, amountOut: 0n, decimals: 18, floorAtomic: 0n }

/** A network without a swap stack cannot price the gas leg, so the sheet stops at the amount step. */
export const NO_SWAP_STACK_COPY =
  "Swap routes are not available on this network, so this withdrawal cannot be priced here."

const dollars = (atomic?: bigint) =>
  atomic === undefined ? "$--" : usdFigure(formatUnits(atomic, DEFAULT_DECIMALS))

/**
 * What a leg commits to at confirm; undefined until its route has priced the exact burn. The floor
 * is the settled one the burn was priced on, not the quote's own: a quote a hair off it would send
 * a burn the estimate was not simulated for.
 */
const legQuote = (
  { status, fee, estimate }: WithdrawalQuoteState,
  floorAtomic: bigint,
): FreshLegQuote | undefined =>
  status === "ready" && fee && estimate
    ? { ...estimate, relayerTip: fee.swapRelayerTip, floorAtomic, proverTip: fee.proverTip }
    : undefined

/**
 * Amount entry → review → two sponsored burns to a fresh L1 address: the gas leg (ETH) first, the
 * funds leg (the picked asset) once the gas leg has mined. Each leg burns its amount plus
 * its route's floor, and the floor comes from pricing that very burn, so a change prices a route
 * twice: once to learn the floor, once with it included.
 *
 * The passkey ceremony is the last beat needing the user: `OperationHandOff` closes the sheet when
 * it ends, and the burns carry on under the bell, which reports their outcome. Cancel is honored
 * only while the first leg is still building. A failure or a closed passkey prompt while the sheet
 * is up returns to confirm, unless the gas leg has mined: the sheet then closes and the bell
 * reports the funds leg. `onDone` fires once: at the hand-off, or when the flow ends first.
 * Each burn, its floor included, is its own withdrawal under the per-withdrawal limit.
 * `resume` sends the funds leg alone, and so does a $0 gas share: one burn, no ETH for the address.
 * Faster tips the funds leg only: it lands last, and every proof that releases it releases the gas
 * leg too.
 */
export function WithdrawFreshModal({
  recipient,
  walletName,
  resume,
  onClose,
  onDone,
}: {
  recipient: Address
  /** User label for the destination; saved with the contact on success. */
  walletName?: string
  /** The funds leg alone, under a group whose gas leg went out. */
  resume?: { groupId: Hex; fundsDisplay?: string; fundsAsset?: WithdrawalReceiveAsset }
  onClose: () => void
  onDone: () => void
}) {
  const { obsidionWallet } = useAztecContext()
  const { obsidionAccount } = useAccountContext()
  const { tokenService } = useAssetContext()
  const { contractService } = useContractServiceContext()
  const { walletAsset, walletBalance, assetsLoaded } = useBalance()
  const { screener, verdict, cleared, rescreen } = useScreenedAddress(recipient, "withdraw")

  const resuming = resume !== undefined
  const [phase, setPhase] = useState<"amount" | "confirm" | "working">("amount")
  const [cancellable, setCancellable] = useState(true)
  const [amount, setAmount] = useState(resume?.fundsDisplay ?? "")
  // MAX sticks: the amount follows the chip, the asset and the priced fee until it is edited.
  const [maxed, setMaxed] = useState(false)
  const [fundsAsset, setFundsAsset] = useState(resume?.fundsAsset ?? "DAI")
  const [gasChoice, setGasChoice] = useState(DEFAULT_GAS)
  const [failedOnce, setFailedOnce] = useState(false)
  // The floor each route charges, as last learned from its own quote; the burns carry it on top.
  const [floors, setFloors] = useState({ funds: 0n, gas: 0n })
  const cancelled = useRef(false)
  const left = useRef(false)
  const legReached = useRef<FreshLeg>("funds")

  const outcome = useProvingOutcome("withdraw")
  const network = getConfig().network

  const leave = () => {
    left.current = true
    outcome.finish()
    onDone()
  }

  const parsed = parseAmount(amount)
  // The decimal-safe parse: undefined for anything the burn would reject.
  const charged = chargedAmount(amount, "0", DEFAULT_DECIMALS)
  const fundsAtomic = charged !== undefined ? parseUnits(charged, DEFAULT_DECIMALS) : undefined

  const gas = resuming ? 0 : gasChoice
  const gasAtomic = parseUnits(String(gas), DEFAULT_DECIMALS)
  // No ETH goes out on a resume or at a $0 share: the funds burn alone, under its own signature.
  const gasLeg = gas > 0
  const firstLeg: FreshLeg = gasLeg ? "gas" : "funds"

  const legs = gasLeg ? 2 : 1
  // Kept through the working phase, so a failed or cancelled flow comes back to the same choice.
  const speed = useSpeedChoice({ active: phase !== "amount", node: obsidionWallet?.node, legs })
  const fundsQuote = useSwapSimulation({
    receiveAsset: fundsAsset,
    amountAtomic: charged !== undefined ? freshLegBurnAmount(charged, floors.funds) : undefined,
    recipient,
    network,
    proverTip: speed.pricedTip,
  })
  const ethQuote = useSwapSimulation({
    // Without a gas leg, price the direct route instead, which reads one portal value.
    receiveAsset: gasLeg ? "ETH" : "DAI",
    amountAtomic: gasLeg ? freshLegBurnAmount(String(gas), floors.gas) : undefined,
    recipient,
    network,
  })
  // A floor learned this render re-prices the burn at once, before anything is committed; a quote
  // within a cent of the floor a burn carries does not move it.
  const learned = {
    funds: settledFloor(floors.funds, fundsQuote.fee?.floorAtomic),
    gas: gasLeg ? settledFloor(floors.gas, ethQuote.fee?.floorAtomic) : 0n,
  }
  if (learned.funds !== floors.funds || learned.gas !== floors.gas) setFloors(learned)

  const quotes = {
    funds: legQuote(fundsQuote, learned.funds),
    gas: gasLeg ? legQuote(ethQuote, learned.gas) : NO_GAS_QUOTE,
  }
  const priced = fundsQuote.fee && (!gasLeg || ethQuote.fee)
  const feeAtomic = priced ? learned.funds + learned.gas : undefined
  const totalAtomic =
    fundsAtomic !== undefined && feeAtomic !== undefined
      ? fundsAtomic + gasAtomic + feeAtomic
      : undefined
  const unavailable =
    fundsQuote.status === "unavailable" || (gasLeg && ethQuote.status === "unavailable")
  const complete =
    charged !== undefined && parsed >= 1 && quotes.funds !== undefined && quotes.gas !== undefined
  // A floor not yet priced counts nothing, so only a known excess shows.
  const problem =
    (fundsAtomic !== undefined ? withdrawalLimitProblem(fundsAtomic + learned.funds) : undefined) ??
    (gasLeg ? withdrawalLimitProblem(gasAtomic + learned.gas) : undefined)
  const valid = complete && !problem
  const balance = walletAsset?.balanceAtomic ?? 0n
  // Only a KNOWN shortfall blocks: a balance still loading reads 0 and would flag every amount.
  const overspent = assetsLoaded && complete && totalAtomic !== undefined && totalAtomic > balance
  // The gas and the fees ride on top, so MAX leaves room for them and keeps the funds burn within
  // the limit; a fee not yet priced takes nothing until it lands. The tip is not in MAX: a maxed
  // amount never moves for it, and Faster is refused below when it would not fit. Under the $1
  // minimum there is nothing to send, and the sheet says why.
  const tipInFee = fundsQuote.fee?.proverTip ?? 0n
  const untippedFee = feeAtomic === undefined ? undefined : feeAtomic - tipInFee
  const room = balance - gasAtomic - (untippedFee ?? 0n)
  const minimum = parseUnits("1", DEFAULT_DECIMALS)
  const short =
    assetsLoaded && untippedFee !== undefined && walletAsset !== null && room < minimum
      ? `Your balance can't cover ${gasLeg ? "the gas share and fees" : "the fees"} (${dollars(
          gasAtomic + untippedFee,
        )}) plus the $1 minimum.`
      : undefined
  const max = walletAsset
    ? withdrawalMaxNet({
        spendableAtomic: balance - gasAtomic - learned.gas,
        feeAtomic: learned.funds - tipInFee,
        decimals: DEFAULT_DECIMALS,
        valuation: NOMINAL_USD_VALUATION,
      })
    : undefined
  const maxAmount =
    max?.status === "available" && max.atomic >= minimum
      ? formatUnits(max.atomic, DEFAULT_DECIMALS)
      : undefined
  if (maxed && maxAmount !== undefined && maxAmount !== amount) setAmount(maxAmount)
  // Each burn carries its tip on top, so what can fall short is the balance or the limit. Judged
  // on the untipped fees, so the answer holds while a tipped quote loads.
  let tipBlocked: string | undefined
  if (speed.offer && feeAtomic !== undefined && fundsAtomic !== undefined) {
    const extra = speed.offer.proverTip - tipInFee
    if (balance - gasAtomic - (feeAtomic + extra) < fundsAtomic)
      tipBlocked = BALANCE_TIP_BLOCKED_COPY
    else if (withdrawalLimitProblem(fundsAtomic + learned.funds + extra))
      tipBlocked = LIMIT_TIP_BLOCKED_COPY
  }
  const speedOutcome = useSpeedOutcome(
    speed,
    speed.offer && feeAtomic !== undefined && fundsAtomic !== undefined ? !tipBlocked : undefined,
    tipBlocked,
  )
  const { proverTip } = speedOutcome
  // The fee on screen was priced with the tip the funds burn will carry.
  const confirmable = fundsQuote.fee?.proverTip === proverTip
  const ready = !!(obsidionWallet && obsidionAccount && tokenService && contractService)
  const busy = useUserFlowActive()
  const busyLabel = useBusyLabel()
  const destination = walletName ? `${walletName} · ${shortAddr(recipient)}` : shortAddr(recipient)
  const confirmTitle = resuming ? "Send remaining funds" : "Withdraw privately"

  const run = async () => {
    if (!valid || !quotes.funds || !quotes.gas) return
    if (failedOnce) fireEvent("retry_clicked", { flow: "withdraw" })
    outcome.start("building")
    setPhase("working")
    setCancellable(true)
    const cancellation = new Error("Cancelled")
    cancelled.current = false
    legReached.current = firstLeg
    fireEvent("withdraw_confirmed")
    const elapsed = lapTimer()
    const burnElapsed = lapTimer()
    // A burn resolves only after its L2 receipt, so submitted == L2 mined; duration spans
    // confirm → mine (the prove-phase split rides tx_timing, flow "withdraw").
    const submitted = (legDollars: number) =>
      fireEvent("withdraw_submitted", {
        duration_ms: elapsed(),
        amount_bucket: amountBucket(BigInt(Math.floor(legDollars)), 0),
      })
    const input = {
      recipient,
      recipientAlias: walletName,
      fundsDisplay: charged,
      gasDisplay: String(gas),
      fundsAsset,
      quotes: { funds: quotes.funds, gas: quotes.gas },
    }
    const onStage = (s: FreshWithdrawStage) => {
      // Only here. `submitting` lands after the burn has mined, and the gateway answers a cancel
      // by dropping the record — past this point that would erase a real withdrawal.
      if (s.leg === firstLeg && s.stage === "proving" && cancelled.current) throw cancellation
      // Only the first leg spans confirm → mined; the second starts after the signature.
      if (s.leg === firstLeg && s.stage === "submitting") void recordBurnDuration(burnElapsed())
      legReached.current = s.leg
      outcome.updateStage(s.stage)
      if (!left.current) setCancellable(s.leg === firstLeg && s.stage === "building")
    }
    try {
      // The confirm CTA gates on `ready`, so the four context values are present here.
      const deps = {
        wallet: obsidionWallet!,
        account: obsidionAccount!,
        tokenService: tokenService!,
        contractService: contractService!,
        screener,
      }
      const result = resume
        ? await resumeFreshAddressFunds(deps, { ...input, groupId: resume.groupId }, onStage)
        : await submitFreshAddressWithdrawal(deps, input, onStage)
      outcome.finish()
      if (result.gas && result.gas.phase !== "submitting") submitted(gas)
      if (result.funds && result.funds.phase !== "submitting") submitted(parsed)
      void upsertSavedL1WalletContact({ address: recipient, name: walletName })
      if (!left.current) onDone()
    } catch (e) {
      const cancel = e === cancellation || isPasskeyCancelled(e)
      if (cancel) outcome.cancel()
      else {
        outcome.finish()
        fireEvent("action_failed", { action: "withdraw:submit", code: failureCode(e) })
      }
      // The funds leg starts only once the gas leg has mined, so reaching it means a withdrawal
      // is on chain whatever failed after.
      const gasMined = gasLeg && legReached.current === "funds"
      if (gasMined) {
        submitted(gas)
        void upsertSavedL1WalletContact({ address: recipient, name: walletName })
      }
      if (left.current) return
      // A retry from confirm would burn the gas a second time.
      if (gasMined) return onDone()
      if (!cancel) {
        showReportableError(e, "withdraw:submit")
        setFailedOnce(true)
      }
      setPhase("confirm")
    }
  }

  // No dismissing while working: Cancel is the way out until the passkey opens.
  const dismiss = phase === "working" ? undefined : onClose

  return (
    <Modal variant="bare" label="Withdraw" className="ww-deposit-warning ww-fund" onClose={dismiss}>
      {phase !== "working" && (
        <>
          {phase === "confirm" && (
            <div className="ww-fresh__back">
              <TopNavIconButton
                icon="chevron-left"
                ariaLabel="Back"
                onClick={() => setPhase("amount")}
              />
            </div>
          )}
          <div className="ww-deposit-warning__close">
            <TopNavIconButton icon="x" ariaLabel="Close" onClick={dismiss} />
          </div>
          <span className="ww-deposit__connect-icon">
            <Icon name="tray-withdraw" size={24} color="#fff" />
          </span>
          <div>
            <GradientText size={24} weight={700}>
              Withdraw
            </GradientText>
            <div className="ww-fund__addr">{destination}</div>
          </div>
          <TeeSignerNotice />
        </>
      )}

      {phase === "amount" && (
        <>
          <div className="ww-fund__fields">
            <span className="ww-fund__label ww-withdraw__amount-label">
              <span>
                Available: <b>${walletBalance}</b>
              </span>
            </span>
            <label className="ww-deposit__input ww-fund__amount">
              <span>
                <input
                  aria-label="Amount"
                  inputMode="decimal"
                  autoFocus
                  data-autofocus
                  placeholder="Minimum $1"
                  value={amount}
                  onChange={(e) => {
                    setMaxed(false)
                    setAmount(decimalInput(e.target.value))
                  }}
                />
                <small>${complete ? parsed : 0}</small>
              </span>
              <span className="ww-withdraw__amount-side">
                <button
                  type="button"
                  className="zkm-btn-reset ww-withdraw__paste"
                  onClick={() => setMaxed(true)}
                >
                  MAX
                </button>
              </span>
            </label>
            <LimitLine
              kind="eachWithdrawal"
              minimum="$1"
              testId="operation-limits"
              info={
                <LimitsInfoButton
                  topic="limit"
                  label="About the withdrawal limit"
                  capacity={{ kind: "active" }}
                />
              }
            />
            {short ? (
              <span className="ww-pay__error">{short}</span>
            ) : problem && !overspent ? (
              <LimitNotice
                operation="withdrawal"
                problem={problem}
                maximum={
                  maxAmount && max?.status === "available" && max.bound !== "protocol-ceiling"
                    ? usdFigureGrouped(maxAmount)
                    : undefined
                }
                onUseMaximum={maxAmount ? () => setMaxed(true) : undefined}
              />
            ) : (
              overspent && <span className="ww-pay__error">Balance not enough</span>
            )}
            {amountError(amount) && <span className="ww-pay__error">{amountError(amount)}</span>}
            {!resuming && (
              <div className="ww-sheet__facts">
                <div className="ww-sheet__fact">
                  <b>Gas for the address</b>
                  <span className="ww-withdraw__tag ww-withdraw__tag--private">Fresh mode</span>
                </div>
                <p className="ww-sheet__note">
                  A share can arrive as ETH in a second withdrawal, so the address can spend without
                  anyone funding it with gas.
                </p>
                <AmountChipRow
                  values={GAS_CHIPS}
                  glass={false}
                  selectedValue={gas}
                  onSelect={setGasChoice}
                />
                <small>
                  {gasLeg
                    ? `About ${usdFigure(String(gas))} of ETH lands with the funds.`
                    : fundsAsset === "ETH"
                    ? "No separate gas withdrawal. The funds arrive as ETH, so the address can spend them."
                    : "No separate gas withdrawal. The address needs ETH from elsewhere before it can spend."}
                </small>
              </div>
            )}
            <div className="ww-deposit__facts">
              <AssetPicker
                value={fundsAsset}
                options={WITHDRAWAL_RECEIVE_ASSETS}
                onChange={setFundsAsset}
              />
              <DepositFact label="Withdrawal fee">
                <b>{dollars(feeAtomic)}</b>
              </DepositFact>
              {/* The gas leg always swaps, so its tip is the bulk of the fee: say what it was priced on,
                  once the whole fee above it is. */}
              {gasLeg && feeAtomic !== undefined && <SwapFeeNote state={ethQuote} />}
              {unavailable && (
                <Warning
                  title={networkHasSwapStack(network) ? FEE_UNAVAILABLE_COPY : NO_SWAP_STACK_COPY}
                />
              )}
            </div>
            {!cleared && (
              <ScreeningNotice
                verdict={verdict}
                checkingCopy="Checking address…"
                blockedFallback="This address can't receive withdrawals."
                errorCopy="Couldn't verify this address. Check your internet connection or try another address."
                onRetry={rescreen}
              />
            )}
          </div>
          <PrimaryGradientButton
            title="Review"
            isDisabled={!valid || overspent || !cleared}
            onClick={() => setPhase("confirm")}
            style={{ width: "100%", height: 48 }}
          />
        </>
      )}

      {phase === "confirm" && (
        <>
          <div className="ww-fund__fields">
            <WithdrawReview
              recipient={recipient}
              walletName={walletName}
              asset={fundsAsset}
              send={
                withdrawalReceiveAsset(fundsAsset).direct
                  ? dollars(fundsAtomic)
                  : `${dollars(fundsAtomic)} ≈ ${estimateText(quotes.funds, fundsAsset)}`
              }
              gas={
                gasLeg
                  ? `${usdFigure(String(gas))} ≈ ${estimateText(quotes.gas, "ETH")}`
                  : undefined
              }
              fee={dollars(feeAtomic)}
              total={dollars(totalAtomic)}
              speed={<SpeedRow choice={speed} outcome={speedOutcome} />}
            />
            {/* Reachable when the balance lands or a fee moves after review — the CTA is dead
                without these. */}
            {overspent ? (
              <span className="ww-pay__error">Balance not enough</span>
            ) : (
              problem && <LimitNotice operation="withdrawal" problem={problem} />
            )}
          </div>
          <PrimaryGradientButton
            title={busy ? busyLabel : ready ? confirmTitle : "Connecting…"}
            isDisabled={!ready || !valid || overspent || !confirmable || busy}
            onClick={run}
            style={{ width: "100%", height: 48 }}
          />
        </>
      )}

      {phase === "working" && (
        <OperationHandOff
          onLeave={leave}
          onCancel={cancellable ? () => (cancelled.current = true) : undefined}
        />
      )}
    </Modal>
  )
}
