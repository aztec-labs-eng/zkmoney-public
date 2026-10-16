import { useEffect, useRef, useState } from "react"
import { parseUnits } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import {
  SavingsFeeError,
  savingsMoveEta,
  savingsPaybackYears,
  SHARE,
  useBalance,
  useSavings,
  type SavingsDirection,
  type SavingsMoveStage,
  type SavingsMoveTiming,
  type SavingsPosition,
  type SavingsQuote,
} from "@obsidion/front-core"
import { isPasskeyCancelled } from "@obsidion/passkey-web"
import {
  GradientText,
  Icon,
  PrimaryGradientButton,
  Spinner,
  TopNavIconButton,
} from "@obsidion/web-ds"
import { showReportableError } from "../../errors/errorModal"
import { failureCode, fireEvent } from "../../lib/analytics"
import {
  amountError,
  decimalInput,
  floorToCents,
  parseAmount,
  usdAtomic,
  usdAtomicFloor,
  usdFigure,
} from "../../ui/format"
import { useProvingOutcome } from "../../ui/hooks"
import { Modal } from "../../ui/Modal"
import { Warning } from "../../ui/Warning"
import { DepositFact } from "../../ui/screens/DepositFact"
import { SponsoredActionNotice, useSponsoredActionBlock } from "../allowance/SponsoredActionNotice"
import { SavingsTermsAccept } from "./SavingsTerms"
import { useBusyLabel } from "../operations/operations"
import { OperationHandOff } from "../operations/OperationHandOff"
import { useUserFlowActive } from "../provingGate"
import { FEE_UNAVAILABLE_COPY } from "../withdraw/withdrawQuote"
import { LimitNotice, usdFigureGrouped } from "../limits/publicLimit"
import {
  sharesBurnLimitProblem,
  sharesBurnMax,
  withdrawalLimitProblem,
  withdrawalMaxAtomic,
} from "../limits/withdrawalLimit"
import { apyPercent } from "./EarningsCalculator"
import { SavingsQuoteChangedError } from "./quoteChanged"
import { savingsEtaCopy, useSavingsMoveTiming } from "./savingsMoveTiming"

const QUOTE_DEBOUNCE_MS = 400

/** A payback time in the unit that fits: days under two months, months under two years, else years. */
function paybackLabel(years: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
  if (years * 12 < 2) return unit(Math.max(1, Math.round(years * 365)), "day")
  if (years < 2) return unit(Math.round(years * 12), "month")
  return unit(Math.round(years), "year")
}

/** A move in pays fees there and back; the sheet says how long they take to earn back, and warns past a year. */
const PAYBACK_WARNING_YEARS = 1

/** What the confirm step says a move takes while the live timing has not loaded. */
const FALLBACK_ESTIMATE = "Usually about 40 min"

/** The whole journey for a move confirmed now: the estimator's submitting phase, from this moment. */
function moveEstimate(timing: SavingsMoveTiming | undefined, nowMs: number): string {
  if (!timing) return FALLBACK_ESTIMATE
  const burn = { phase: "submitting" as const, startTime: nowMs }
  const eta = savingsMoveEta({ startTime: nowMs }, burn, timing, nowMs)
  return eta ? savingsEtaCopy(eta) : FALLBACK_ESTIMATE
}

/** The shares worth `value` DAI at the position's price; every share for the whole value. */
export function sharesFor(
  position: Pick<SavingsPosition, "shares" | "value">,
  value: bigint,
): bigint {
  if (position.value === 0n || value >= position.value) return position.shares
  return (value * position.shares) / position.value
}

/**
 * Amount entry, review and the sponsored burn of a move between Main and Savings. The typed
 * figure is what leaves the source; the fee comes out of it and the rest lands. The passkey
 * ceremony is the last beat needing the user: `OperationHandOff` then closes the sheet while the
 * proof and the send carry on under the bell. Cancel is honored only while the burn is still building.
 */
export function MoveFundsSheet({
  direction: initialDirection,
  initialAmount = "",
  onClose,
}: {
  direction: SavingsDirection
  initialAmount?: string
  onClose: () => void
}) {
  const { position, quote, move } = useSavings()
  const { walletAsset, assetsLoaded } = useBalance()
  const [direction, setDirection] = useState(initialDirection)
  const [amount, setAmount] = useState(initialAmount)
  const [maxed, setMaxed] = useState(false)
  const [phase, setPhase] = useState<"amount" | "confirm" | "working">("amount")
  const [stage, setStage] = useState<SavingsMoveStage>("building")
  const [priced, setPriced] = useState<{
    key: string
    quote?: SavingsQuote
    /** This quote's fee plus the fee of moving its net back, for a move in with a priced position. */
    roundTrip?: bigint
    error?: string
  } | null>(null)
  const [quoting, setQuoting] = useState(false)
  /** Why the review shows figures other than the ones confirmed. */
  const [requoted, setRequoted] = useState<string>()
  // A move in needs the terms accepted here, each time; a move out is the user's own funds coming back.
  const [accepted, setAccepted] = useState(false)
  const termsNeeded = direction === "in" && !accepted
  const cancelled = useRef(false)
  const left = useRef(false)
  const outcome = useProvingOutcome("savings")
  const busy = useUserFlowActive()
  const busyLabel = useBusyLabel()
  const unsponsored = useSponsoredActionBlock(phase === "confirm")
  const timing = useSavingsMoveTiming()

  const from = direction === "in" ? "Main Account" : "Savings"
  const to = direction === "in" ? "Savings" : "Main Account"
  const available = direction === "in" ? walletAsset?.balanceAtomic ?? 0n : position?.value ?? 0n
  const availableKnown = direction === "in" ? assetsLoaded : position !== null
  const parsed = parseAmount(amount)
  const valueAtomic =
    !amountError(amount) && parsed > 0 ? parseUnits(amount, DEFAULT_DECIMALS) : undefined
  const maxShares = position ? sharesBurnMax(position.shares) : undefined
  // MAX moving in stops at Main's withdrawal limit; moving out, at the per-burn share maximum.
  const maxValue =
    direction === "in"
      ? withdrawalMaxAtomic(available) ?? 0n
      : position && maxShares !== undefined && position.shares > 0n
      ? (position.value * maxShares) / position.shares
      : available
  // MAX shows the balance to the cent, rounded down; while it stands, the move takes the whole
  // balance, so a move out leaves no share behind and a move in none of the DAI past the cent.
  const maxAmount =
    availableKnown && maxValue > 0n ? floorToCents(maxValue, DEFAULT_DECIMALS) : undefined
  if (maxed && maxAmount !== undefined && maxAmount !== amount) setAmount(maxAmount)
  // What the burn removes: DAI moving in, shares moving out.
  const burnAtomic =
    maxed && maxAmount !== undefined
      ? direction === "in"
        ? maxValue
        : maxShares
      : valueAtomic === undefined
      ? undefined
      : direction === "in"
      ? valueAtomic
      : position
      ? sharesFor(position, valueAtomic)
      : undefined
  // A move in pays its fee on top, so Savings receives what was typed; MAX has nothing on top.
  const feeOnTop = direction === "in" && !maxed
  const overspent = availableKnown && valueAtomic !== undefined && valueAtomic > available
  // The limit a withdrawal of this burn meets: Main's on the DAI moving in, the per-burn maximum on
  // the shares moving out.
  const limitProblem =
    burnAtomic === undefined
      ? undefined
      : direction === "in"
      ? withdrawalLimitProblem(burnAtomic)
      : sharesBurnLimitProblem(burnAtomic)
  const key =
    burnAtomic === undefined ? "" : `${direction}:${burnAtomic}:${feeOnTop ? "top" : "off"}`

  useEffect(() => {
    if (!key || burnAtomic === undefined || burnAtomic <= 0n || overspent) {
      setPriced(null)
      setQuoting(false)
      return
    }
    let stale = false
    setQuoting(true)
    const priceMove = async () => {
      if (!feeOnTop) return quote(direction, burnAtomic)
      // Burn the shortfall on top until the net lands at the typed figure; fees can move between quotes.
      let gross = burnAtomic
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const result = await quote("in", gross)
          if (result.net >= burnAtomic) return result
          gross += burnAtomic - result.net
        } catch (err) {
          if (!(err instanceof SavingsFeeError)) throw err
          gross = burnAtomic + err.fee
        }
      }
      throw new Error("Fee on top did not settle")
    }
    const timer = setTimeout(() => {
      priceMove()
        .then(
          async (result) => {
            // Moving in pays fees there and back: the way back is quoted for the net that lands.
            const roundTrip =
              direction === "in" && position && position.sharePrice > 0n
                ? await quote("out", (result.net * SHARE) / position.sharePrice).then(
                    (back) => result.fee + back.fee,
                    () => undefined,
                  )
                : undefined
            if (!stale) setPriced({ key, quote: result, roundTrip })
          },
          (err: unknown) =>
            !stale &&
            setPriced({
              key,
              error:
                err instanceof SavingsFeeError
                  ? `The amount does not cover the L1 fee (${usdAtomic(err.fee)}).`
                  : FEE_UNAVAILABLE_COPY,
            }),
        )
        .finally(() => !stale && setQuoting(false))
    }, QUOTE_DEBOUNCE_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [key, direction, burnAtomic, overspent, feeOnTop, quote])

  const current = priced?.key === key ? priced : null
  const quoted = current?.quote
  // Once priced, what Main burns is the quote's amount: the typed figure plus the fee on a move in.
  const feeOverspent =
    feeOnTop && availableKnown && quoted !== undefined && quoted.amount > available
  const grossLimitProblem =
    feeOnTop && quoted !== undefined ? withdrawalLimitProblem(quoted.amount) : undefined
  const payback =
    direction === "in" && quoted && current?.roundTrip !== undefined && position?.apy !== undefined
      ? savingsPaybackYears(quoted.net, current.roundTrip, position.apy)
      : undefined
  const paybackLine =
    payback !== undefined &&
    Number.isFinite(payback) &&
    position?.apy !== undefined &&
    current?.roundTrip !== undefined &&
    current.roundTrip > 0n
      ? `At ${apyPercent(position.apy)} APY it takes about ${paybackLabel(
          payback,
        )} to earn back the ${usdAtomic(current.roundTrip)} in fees to move to savings and back.`
      : undefined
  const slowPayback = payback !== undefined && payback > PAYBACK_WARNING_YEARS
  const valid =
    burnAtomic !== undefined &&
    burnAtomic > 0n &&
    !overspent &&
    !feeOverspent &&
    !limitProblem &&
    !grossLimitProblem &&
    quoted !== undefined &&
    !quoting
  const figure = (value: bigint | undefined) =>
    quoting ? "…" : value === undefined ? "$--" : usdAtomicFloor(value)
  const exact = (value: bigint | undefined) =>
    quoting ? "…" : value === undefined ? "$--" : usdAtomic(value)

  const run = async () => {
    if (!valid || quoted === undefined) return
    outcome.start("building")
    setRequoted(undefined)
    setPhase("working")
    setStage("building")
    const cancellation = new Error("Cancelled")
    cancelled.current = false
    try {
      await move(direction, quoted.amount, (next) => {
        // Only here: past the proof the burn is away, and a cancel would erase a real move.
        if (next === "proving" && cancelled.current) throw cancellation
        outcome.updateStage(next)
        setStage(next)
      })
      outcome.finish()
      if (!left.current) onClose()
    } catch (e) {
      if (e === cancellation || isPasskeyCancelled(e)) {
        outcome.cancel()
        setPhase("confirm")
        return
      }
      outcome.finish()
      if (e instanceof SavingsQuoteChangedError) {
        if (left.current) return
        setPriced({ key, quote: e.quote, roundTrip: current?.roundTrip })
        setRequoted(e.message)
        setPhase("confirm")
        return
      }
      fireEvent("action_failed", { action: "savings:move", code: failureCode(e) })
      if (left.current) return
      showReportableError(e, "savings:move")
      setPhase("confirm")
    }
  }
  const leave = () => {
    left.current = true
    outcome.finish()
    onClose()
  }
  const dismiss = phase === "working" ? undefined : onClose

  return (
    <Modal
      variant="bare"
      label="Move funds"
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
              <Icon name="earn" size={24} color="#fff" />
            </span>
          )}
          <GradientText size={24} weight={700}>
            {direction === "in" ? "Add to Savings" : "Move to Main Account"}
          </GradientText>
        </>
      )}

      {phase === "amount" && (
        <>
          <div className="ww-fund__fields">
            <div className="ww-move__route">
              <span>
                <small>From</small>
                <b>{from}</b>
              </span>
              <button
                type="button"
                className="zkm-btn-reset ww-move__swap"
                aria-label="Swap direction"
                onClick={() => {
                  setDirection(direction === "in" ? "out" : "in")
                  setMaxed(false)
                }}
              >
                <Icon name="payments-arrows-horizontal" size={16} />
              </button>
              <span>
                <small>To</small>
                <b>{to}</b>
              </span>
            </div>
            <span className="ww-fund__label ww-withdraw__amount-label">
              <span>Amount to move</span>
              <span>
                Available: <b>{availableKnown ? usdAtomicFloor(available) : "—"}</b>
              </span>
            </span>
            <label className="ww-deposit__input ww-fund__amount">
              <span>
                <input
                  aria-label="Amount to move"
                  inputMode="decimal"
                  autoFocus
                  data-autofocus
                  placeholder="$0.00"
                  value={amount}
                  onChange={(e) => {
                    setMaxed(false)
                    setAmount(decimalInput(e.target.value))
                  }}
                />
                <small>{usdFigure(String(Number.isFinite(parsed) ? parsed : 0))}</small>
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
              </span>
            </label>
            {overspent ? (
              <span className="ww-pay__error">Balance not enough</span>
            ) : feeOverspent ? (
              <span className="ww-pay__error">
                Balance not enough for the amount plus the fee ({usdAtomic(quoted!.amount)})
              </span>
            ) : limitProblem ?? grossLimitProblem ? (
              <LimitNotice
                operation="withdrawal"
                problem={(limitProblem ?? grossLimitProblem)!}
                maximum={maxAmount && usdFigureGrouped(maxAmount)}
                onUseMaximum={maxAmount ? () => setMaxed(true) : undefined}
              />
            ) : amountError(amount) ? (
              <span className="ww-pay__error">{amountError(amount)}</span>
            ) : (
              current?.error && <span className="ww-pay__error">{current.error}</span>
            )}
            <div className="ww-deposit__input ww-sheet__fact">
              <span>L1 fee</span>
              <b style={{ fontSize: 14 }}>{figure(quoted?.fee)}</b>
            </div>
            <div className="ww-deposit__input ww-sheet__fact">
              {feeOnTop ? (
                <>
                  <span>{from} pays</span>
                  <b style={{ fontSize: 14 }}>{figure(quoted?.value)}</b>
                </>
              ) : (
                <>
                  <span>{to} receives</span>
                  <b style={{ fontSize: 14 }}>≈ {figure(quoted?.net)}</b>
                </>
              )}
            </div>
            {quoting && (
              <p
                className="ww-sheet__note"
                role="status"
                style={{ display: "flex", alignItems: "center", gap: 6 }}
              >
                <Spinner size={12} color="currentColor" /> Getting fee…
              </p>
            )}
            {direction === "in" && (
              <p className="ww-sheet__note">
                {position?.apy !== undefined
                  ? `Current APY ${apyPercent(position.apy)}.`
                  : "Rate unavailable"}
              </p>
            )}
            {paybackLine &&
              (slowPayback ? (
                <Warning tone="warning" title={paybackLine} />
              ) : (
                <p className="ww-sheet__note">{paybackLine}</p>
              ))}
          </div>
          <PrimaryGradientButton
            title="Review"
            isDisabled={!valid}
            onClick={() => setPhase("confirm")}
            style={{ width: "100%", height: 48 }}
          />
        </>
      )}

      {phase === "confirm" && (
        <>
          <div className="ww-fund__fields">
            <div className="ww-sheet__facts">
              <DepositFact label="From">
                <b>{from}</b>
              </DepositFact>
              <DepositFact label="To">
                <b>{to}</b>
              </DepositFact>
              <DepositFact label="Amount">
                <b>{exact(feeOnTop ? quoted?.net : quoted?.value)}</b>
              </DepositFact>
              <DepositFact label="L1 fee">
                <b>{exact(quoted?.fee)}</b>
              </DepositFact>
              <hr className="ww-divider" />
              {feeOnTop ? (
                <DepositFact label={`${from} pays`}>
                  <b>{exact(quoted?.value)}</b>
                </DepositFact>
              ) : (
                <DepositFact label={`${to} receives`}>
                  <b>≈ {exact(quoted?.net)}</b>
                </DepositFact>
              )}
              <DepositFact label="Estimated time">
                <b>{moveEstimate(timing, Date.now())}</b>
              </DepositFact>
            </div>
            {(overspent || feeOverspent) && (
              <span className="ww-pay__error">Balance not enough</span>
            )}
            {current?.error && <span className="ww-pay__error">{current.error}</span>}
            {requoted && <Warning tone="warning" title={requoted} />}
            <p className="ww-sheet__note">Keep this tab open until the move is sent.</p>
            {direction === "in" && (
              <SavingsTermsAccept accepted={accepted} onChange={setAccepted} />
            )}
          </div>
          <SponsoredActionNotice reason={unsponsored} />
          <PrimaryGradientButton
            title={busy ? busyLabel : "Confirm move"}
            isDisabled={!valid || busy || !!unsponsored || termsNeeded}
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
