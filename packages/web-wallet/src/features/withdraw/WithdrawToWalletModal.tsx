import { Modal } from "../../ui/Modal"
import { useRef, useState } from "react"
import { formatUnits, parseUnits, type Address } from "viem"
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
import { GradientText, Icon, PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"
import { chargedAmount } from "../deposit/DepositFromWalletModal"
import { showReportableError } from "../../errors/errorModal"
import { amountBucket, failureCode, fireEvent, lapTimer } from "../../lib/analytics"
import { amountError, decimalInput, parseAmount, usdFigure } from "../../ui/format"
import { useProvingOutcome } from "../../ui/hooks"
import { useUserFlowActive } from "../provingGate"
import { useBusyLabel } from "../operations/operations"
import { OperationHandOff } from "../operations/OperationHandOff"
import { LocalPasskeyHint } from "../../ui/LocalPasskeyHint"
import { SponsoredActionNotice, useSponsoredActionBlock } from "../allowance/SponsoredActionNotice"
import { ScreeningNotice, useScreenedAddress } from "../../ui/screening"
import { TeeSignerNotice } from "../../ui/TeeSignerNotice"
import { Warning } from "../../ui/Warning"
import { submitSponsoredWithdrawal, type WithdrawStage } from "./withdrawGateway"
import { getConfig } from "../../config/env"
import {
  FEE_UNAVAILABLE_COPY,
  settledFloor,
  SwapFeeNote,
  SwapGasWarning,
  useSwapSimulation,
  WithdrawalEstimate,
} from "./withdrawQuote"
import { withdrawalReceiveAsset, type WithdrawalReceiveAsset } from "./withdrawAssets"
import { WithdrawalAssetPicker } from "./WithdrawalAssetPicker"
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
  LimitNotice,
  OperationLimits,
  usdFigureGrouped,
  type LimitProblem,
} from "../limits/publicLimit"
import { LimitsInfoButton } from "../limits/AboutLimitsSheet"
import { withdrawalLimitProblem } from "../limits/withdrawalLimit"

/**
 * Amount entry → confirmation → sponsored L2 burn to the given L1 recipient. The typed amount is
 * what the recipient should receive; the route's floor is burned on top of it.
 *
 * The passkey ceremony is the last beat needing the user: the modal holds them through the prepare
 * and sign beats, then `OperationHandOff` closes it while the burn carries on under the bell, with
 * no cancel since the burn is away. Cancel is only honoured while
 * the burn is still building; past that the passkey sheet's own dismiss is the way out, and it fails
 * the withdrawal pre-mine. `onDone` fires once per burn: at the hand-off, or when it mines first.
 */
export function WithdrawToWalletModal({
  recipient,
  walletName,
  receiveAsset: initialAsset = "DAI",
  recipientIsContract,
  onClose,
  onDone,
}: {
  recipient: Address
  /** User label for the destination; saved with the contact on success. */
  walletName?: string
  /** The output the sheet opens on: DAI burns straight to the recipient; anything else routes
   *  through oxide's swap escrow (see `submitSponsoredWithdrawal`). */
  receiveAsset?: WithdrawalReceiveAsset
  /** The ETH route pays with a plain transfer, which a contract can reject. */
  recipientIsContract?: boolean
  onClose: () => void
  onDone: () => void
}) {
  const { obsidionWallet } = useAztecContext()
  const { obsidionAccount } = useAccountContext()
  const { tokenService } = useAssetContext()
  const { contractService } = useContractServiceContext()
  const { walletAsset, walletBalance, assetsLoaded } = useBalance()
  const { screener, verdict, cleared, rescreen } = useScreenedAddress(recipient, "withdraw")

  const [phase, setPhase] = useState<"amount" | "confirm" | "working">("amount")
  const [stage, setStage] = useState<WithdrawStage>("building")
  const [amount, setAmount] = useState("")
  // MAX sticks: the amount follows the asset and the priced fee until it is edited.
  const [maxed, setMaxed] = useState(false)
  const [receiveAsset, setReceiveAsset] = useState(initialAsset)
  const [failedOnce, setFailedOnce] = useState(false)
  const cancelled = useRef(false)
  const left = useRef(false)

  const outcome = useProvingOutcome("withdraw")

  const leave = () => {
    left.current = true
    outcome.finish()
    onDone()
  }

  const parsed = parseAmount(amount)
  const receiveOption = withdrawalReceiveAsset(receiveAsset)
  // The typed amount is what the recipient should receive and the route's floor rides on top, so
  // the burn is the two together. `charged` is the decimal-safe parse: undefined for anything the
  // burn would reject, which gates the exact-units comparisons below that would otherwise throw.
  const charged = chargedAmount(amount, "0", DEFAULT_DECIMALS)
  const sendAtomic = charged !== undefined ? parseUnits(charged, DEFAULT_DECIMALS) : undefined
  // The floor the route charges, as last learned from its own quote. The floor comes from pricing
  // the very burn that carries it, so a change prices the route twice: once to learn the floor,
  // once with it included.
  const [floor, setFloor] = useState(0n)
  const burnAtomic = sendAtomic !== undefined ? sendAtomic + floor : undefined
  // Kept through the working phase, so a failed or cancelled burn comes back to the same choice.
  const speed = useSpeedChoice({ active: phase !== "amount", node: obsidionWallet?.node })
  // A swap simulation nets its own fees off its input, so it is priced on the burn.
  const quote = useSwapSimulation({
    receiveAsset,
    amountAtomic: burnAtomic,
    recipient,
    network: getConfig().network,
    proverTip: speed.pricedTip,
  })
  // A floor learned this render re-prices the burn at once, before anything is committed. The fee
  // shown is the floor the burn carries, which a quote within a cent of it does not move.
  const learned = settledFloor(floor, quote.fee?.floorAtomic)
  if (learned !== floor) setFloor(learned)
  const feeAtomic = quote.fee === undefined ? undefined : learned
  const minimum = parseUnits("1", DEFAULT_DECIMALS)
  // The balance is the deployment's settlement token, which policy values at a stated $1.
  const valuation = NOMINAL_USD_VALUATION
  // A floor not yet priced counts nothing, so only a known excess shows.
  const problem: LimitProblem | undefined =
    burnAtomic !== undefined ? withdrawalLimitProblem(burnAtomic) : undefined
  // A route that cannot be priced has no fee to charge and no tip to commit to, so it never
  // validates.
  const valid = charged !== undefined && parsed >= 1 && quote.fee !== undefined && !problem
  // The tip the burn commits to is the one on screen: a swap confirms only off a settled simulation.
  const swapCommit =
    !receiveOption.direct && quote.status === "ready" && quote.fee && quote.estimate
      ? { relayerTip: quote.fee.swapRelayerTip, ...quote.estimate }
      : undefined
  const balance = walletAsset?.balanceAtomic ?? 0n
  // Only a KNOWN shortfall blocks: a balance still loading reads 0 and would flag every amount.
  // Checked apart from `valid`: an amount over both the balance and the limit names the balance.
  const overspent = assetsLoaded && burnAtomic !== undefined && burnAtomic > balance
  // The fee rides on top, so MAX leaves room for it and keeps the burn within the limit; a fee not
  // yet priced takes nothing until it lands. The tip is not in MAX: a maxed amount never moves for
  // it, and Faster is refused below when it would not fit.
  const tipInFee = quote.fee?.proverTip ?? 0n
  const max = walletAsset
    ? withdrawalMaxNet({
        spendableAtomic: balance,
        feeAtomic: learned - tipInFee,
        decimals: DEFAULT_DECIMALS,
        valuation,
      })
    : undefined
  const maxAmount =
    max?.status === "available" && max.atomic >= minimum
      ? formatUnits(max.atomic, DEFAULT_DECIMALS)
      : undefined
  if (maxed && maxAmount !== undefined && maxAmount !== amount) setAmount(maxAmount)
  const feeFigure =
    feeAtomic === undefined ? "$--" : usdFigure(formatUnits(feeAtomic, DEFAULT_DECIMALS))
  // Under the $1 minimum there is nothing to send, and the sheet says why.
  const short =
    assetsLoaded &&
    walletAsset &&
    feeAtomic !== undefined &&
    balance - (feeAtomic - tipInFee) < minimum
      ? `Your balance can't cover the withdrawal fee (${feeFigure}) plus the $1 minimum.`
      : undefined
  // The tip rides on top too, so what can fall short is the balance or the limit. Judged on the
  // untipped fee, so the answer holds while a tipped quote loads.
  let tipBlocked: string | undefined
  if (speed.offer && feeAtomic !== undefined && sendAtomic !== undefined) {
    const extra = speed.offer.proverTip - tipInFee
    if (balance - (feeAtomic + extra) < sendAtomic) tipBlocked = BALANCE_TIP_BLOCKED_COPY
    else if (withdrawalLimitProblem(sendAtomic + learned + extra))
      tipBlocked = LIMIT_TIP_BLOCKED_COPY
  }
  const speedOutcome = useSpeedOutcome(
    speed,
    speed.offer && feeAtomic !== undefined && sendAtomic !== undefined ? !tipBlocked : undefined,
    tipBlocked,
  )
  const { proverTip } = speedOutcome
  // The fee on screen was priced with the tip the burn will carry.
  const confirmable =
    (receiveOption.direct || swapCommit !== undefined) && quote.fee?.proverTip === proverTip
  const ready = !!(obsidionWallet && obsidionAccount && tokenService && contractService)
  const busy = useUserFlowActive()
  const busyLabel = useBusyLabel()
  // What the recipient should receive, in the burned asset; a swap route swaps it.
  const sent = charged !== undefined ? usdFigure(charged) : "$--"
  const total =
    burnAtomic !== undefined && feeAtomic !== undefined
      ? usdFigure(formatUnits(burnAtomic, DEFAULT_DECIMALS))
      : "$--"
  const unsponsored = useSponsoredActionBlock(phase === "confirm")

  const run = async () => {
    if (!valid || burnAtomic === undefined) return
    if (failedOnce) fireEvent("retry_clicked", { flow: "withdraw" })
    outcome.start("building")
    setPhase("working")
    setStage("building")
    const cancellation = new Error("Cancelled")
    cancelled.current = false
    fireEvent("withdraw_confirmed")
    const elapsed = lapTimer()
    try {
      // The confirm CTA gates on `ready`, so the four context values are present here.
      const record = await submitSponsoredWithdrawal(
        {
          wallet: obsidionWallet!,
          account: obsidionAccount!,
          tokenService: tokenService!,
          contractService: contractService!,
          screener,
        },
        recipient,
        formatUnits(burnAtomic, DEFAULT_DECIMALS),
        (s) => {
          // Only here. `submitting` lands after the burn has mined, and the gateway answers a
          // cancel by dropping the record — past this point that would erase a real withdrawal.
          if (s === "proving" && cancelled.current) throw cancellation
          outcome.updateStage(s)
          setStage(s)
        },
        walletName,
        receiveAsset,
        swapCommit,
        proverTip,
      )
      outcome.finish()
      // The sponsored send resolves only after the L2 receipt, so submitted == L2 mined here;
      // duration spans confirm → mine (the prove-phase split rides tx_timing, flow "withdraw").
      if (record.phase !== "submitting") {
        const durationMs = elapsed()
        void recordBurnDuration(durationMs)
        fireEvent("withdraw_submitted", {
          duration_ms: durationMs,
          amount_bucket: amountBucket(BigInt(Math.floor(parsed)), 0),
        })
      }
      void upsertSavedL1WalletContact({ address: recipient, name: walletName })
      if (!left.current) onDone()
    } catch (e) {
      if (e === cancellation || isPasskeyCancelled(e)) {
        outcome.cancel()
        setPhase("confirm")
        return
      }
      outcome.finish()
      fireEvent("action_failed", { action: "withdraw:submit", code: failureCode(e) })
      if (left.current) return
      showReportableError(e, "withdraw:submit")
      setFailedOnce(true)
      setPhase("confirm")
    }
  }

  // No dismissing mid-burn: the record is already seeded and the proof cannot be abandoned safely.
  const dismiss = phase === "working" ? undefined : onClose

  return (
    <Modal
      variant="bare"
      label="Withdraw"
      className={phase === "confirm" ? "ww-deposit-warning ww-sheet--detail" : "ww-deposit-warning"}
      onClose={dismiss}
    >
      {phase !== "working" && (
        <>
          <div className="ww-deposit-warning__close">
            <TopNavIconButton icon="x" ariaLabel="Close" onClick={dismiss} />
          </div>
          {phase === "confirm" && (
            <span className="ww-deposit__connect-icon">
              <Icon name="tray-withdraw" size={24} color="#fff" />
            </span>
          )}
          <GradientText size={24} weight={700}>
            Withdraw
          </GradientText>
          <TeeSignerNotice />
        </>
      )}

      {phase === "amount" && (
        <>
          <div className="ww-fund__fields">
            <span className="ww-fund__label ww-withdraw__amount-label">
              <span>Amount to send</span>
              <span>
                Available: <b>{usdFigureGrouped(String(walletBalance))}</b>
              </span>
            </span>
            <label className="ww-deposit__input ww-fund__amount">
              <span>
                <input
                  aria-label="Amount to send"
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
                <small>{usdFigureGrouped(String(Number.isFinite(parsed) ? parsed : 0))}</small>
              </span>
              <span className="ww-withdraw__amount-side">
                <button
                  type="button"
                  className="zkm-btn-reset ww-withdraw__paste"
                  disabled={!maxAmount}
                  onClick={() => setMaxed(true)}
                >
                  MAX
                </button>
                <WithdrawalAssetPicker inline value={receiveAsset} onChange={setReceiveAsset} />
              </span>
            </label>
            <OperationLimits
              operation="withdrawal"
              minimum="$1"
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
            <div className="ww-deposit__input ww-sheet__fact">
              <span>Withdrawal fee</span>
              <b style={{ fontSize: 14 }}>{feeFigure}</b>
            </div>
            {receiveOption.direct ? (
              quote.status === "unavailable" && <Warning title={FEE_UNAVAILABLE_COPY} />
            ) : (
              <>
                <SwapFeeNote state={quote} />
                <div className="ww-fund__label">
                  <WithdrawalEstimate receiveAsset={receiveAsset} state={quote} />
                </div>
                <SwapGasWarning state={quote} amountAtomic={sendAtomic} />
              </>
            )}
            {recipientIsContract && receiveAsset === "ETH" && (
              <Warning title="This address is a contract">
                The ETH route pays it with a plain transfer, and a contract that rejects ETH would
                leave the funds stuck at the swap escrow. Pick a different address, or receive USDC
                or USDT instead.
              </Warning>
            )}
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
              asset={receiveAsset}
              send={
                receiveOption.direct ? sent : `${sent} ≈ ${estimateText(swapCommit, receiveAsset)}`
              }
              fee={feeFigure}
              total={total}
              speed={<SpeedRow choice={speed} outcome={speedOutcome} />}
            />
            {/* Reachable when the balance lands after review — the CTA is dead without this. */}
            {overspent && <span className="ww-pay__error">Balance not enough</span>}
          </div>
          <SponsoredActionNotice reason={unsponsored} />
          <LocalPasskeyHint />
          <PrimaryGradientButton
            title={busy ? busyLabel : ready ? "Confirm withdrawal" : "Connecting…"}
            isDisabled={!ready || !valid || overspent || !confirmable || busy || !!unsponsored}
            onClick={run}
            style={{ width: "100%" }}
          />
        </>
      )}

      {phase === "working" && (
        <OperationHandOff
          onLeave={leave}
          onCancel={
            stage === "building"
              ? () => {
                  cancelled.current = true
                }
              : undefined
          }
        />
      )}
    </Modal>
  )
}
