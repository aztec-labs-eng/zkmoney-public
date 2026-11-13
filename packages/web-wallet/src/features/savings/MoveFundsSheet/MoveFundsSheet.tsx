import { useEffect, useRef, useState } from "react"
import { parseUnits, type Address } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import {
  assetUsd,
  bestEffort,
  savingsMoveEta,
  savingsPaybackYears,
  UNREAD,
  useStore,
  type MoveQuote,
  type SavingsDirection,
  type SavingsMoveTiming,
  WalletError,
} from "@obsidion/front-core"
import { isPasskeyCancelled } from "@obsidion/passkey-web"
import {
  GradientText,
  Icon,
  PrimaryGradientButton,
  Spinner,
  TopNavIconButton,
} from "@obsidion/web-ds"
import { showReportableError } from "../../../errors/errorModal"
import { failureCode, fireEvent } from "../../../lib/analytics"
import {
  amountError,
  decimalInput,
  floorToCents,
  parseAmount,
  usdAtomic,
  usdAtomicFloor,
  usdFigure,
} from "../../../ui/format"
import { useProvingOutcome } from "../../../ui/hooks"
import { Modal } from "../../../ui/Modal"
import { Warning } from "../../../ui/Warning"
import { DepositFact } from "../../../ui/screens/DepositFact"
import {
  SponsoredActionNotice,
  useSponsoredActionBlock,
} from "../../allowance/SponsoredActionNotice"
import { SavingsTermsAccept } from "../SavingsTerms"
import { failureCodeOf, useBusyLabel, useUserFlowActive } from "../../operations/operations"
import { OperationHandOff } from "../../operations/OperationHandOff"
import { FEE_UNAVAILABLE_COPY, ProtocolFeeNote } from "../../withdraw/withdrawQuote"
import { LimitNotice, usdFigureGrouped } from "../../limits/publicLimit"
import {
  sharesBurnLimitProblem,
  sharesBurnMax,
  withdrawalLimitProblem,
  withdrawalMaxAtomic,
} from "../../limits/withdrawalLimit"
import { apyPercent } from "../EarningsCalculator"
import { moveOperationId } from "../movesSession"
import { moveOutSource, type SavingsPosition } from "../savingsLine"
import { savingsEtaCopy, useSavingsMoveTiming } from "../savingsMoveTiming"
import { useTxAmountCap } from "../../token/useTxAmountCap"
import { useSession } from "../../../session/session"
import styles from "./MoveFundsSheet.module.css"
import copy from "./MoveFundsSheet.copy"
import { fmt } from "../../../lib/fmt"

const QUOTE_DEBOUNCE_MS = 400

/** A payback time in the unit that fits: days under two months, months under two years, else years. */
function paybackLabel(years: number): string {
  const unit = (count: number, word: "day" | "month" | "year") =>
    fmt(copy.payback[count === 1 ? word : (`${word}s` as const)], { count })
  if (years * 12 < 2) return unit(Math.max(1, Math.round(years * 365)), "day")
  if (years < 2) return unit(Math.round(years * 12), "month")
  return unit(Math.round(years), "year")
}

/** The sheet says how long a move in takes to earn back its fee, and warns past a year. */
const PAYBACK_WARNING_YEARS = 1

/** What the confirm step says a move takes while the live timing has not loaded. */
const FALLBACK_ESTIMATE = copy.fallbackEstimate

/** The whole journey for a move confirmed now: the estimator's submitting phase, from this moment. */
function moveEstimate(timing: SavingsMoveTiming | undefined, nowMs: number): string {
  if (!timing) return FALLBACK_ESTIMATE
  const burn = { phase: "submitting" as const, startTime: nowMs }
  const eta = savingsMoveEta({ phase: "burning", startTime: nowMs }, burn, timing, nowMs)
  return eta ? savingsEtaCopy(eta) : FALLBACK_ESTIMATE
}

/** A move's quote as the sheet shows it, in DAI: what leaves the source, what lands, the fee. */
interface SheetQuote {
  /** What the source burns: DAI moving in, shares moving out. */
  amount: bigint
  value: bigint
  net: bigint
  fee: bigint
  quote: MoveQuote
}

/** `assetDecimals`: the vault's asset's, which the quote's vault side is in. */
export function sheetQuote(
  direction: SavingsDirection,
  amount: bigint,
  quote: MoveQuote,
  assetDecimals: number,
): SheetQuote {
  const usd = (assets: bigint) => assetUsd(assets, { assetDecimals })
  const value = direction === "in" ? amount : usd(quote.expectedOut)
  const net = direction === "in" ? usd(quote.conversionOut) : quote.conversionOut
  return { amount, value, net, fee: value - net, quote }
}

/** The tips a quote refused for exceeding the burn, in the burn's units. */
const tipsOf = (err: unknown): bigint | undefined =>
  err instanceof WalletError && err.code === "move.tipsExceedAmount" && err.data?.tips
    ? BigInt(err.data.tips)
    : undefined

/** The shares worth `value` dollars, at the position's dollar value; every share for all of it. */
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
  const txAmountCap = useTxAmountCap()
  const session = useSession()
  const savings = useStore(session.savingsLine)
  const [chosen, setDirection] = useState(initialDirection)
  // A line the profile no longer lists only lets its shares leave.
  const direction: SavingsDirection = savings.line?.exitOnly ? "out" : chosen
  const [amount, setAmount] = useState(initialAmount)
  const parsed = parseAmount(amount)
  const valueAtomic =
    !amountError(amount) && parsed > 0 ? parseUnits(amount, DEFAULT_DECIMALS) : undefined
  // A move in goes to the first line. A move out empties a line the profile no longer lists first,
  // and takes from the next what that line cannot cover.
  const source = direction === "out" ? moveOutSource(savings, valueAtomic) : undefined
  const line = source?.line ?? savings.line
  const position = source?.position ?? savings.position
  const assetDecimals = position?.assetDecimals ?? savings.price?.assetDecimals
  // What the shares are worth, in dollars like the typed figure.
  const worth = position ? assetUsd(position.value, position) : undefined
  const savingsCap = useStore(
    line ? session.page.chain.txAmountCap(line.held.portal as Address) : UNREAD,
    (state) => (state.status === "ready" ? state.value : undefined),
  )
  const wallet = useStore(session.balances.view)
  const [maxed, setMaxed] = useState(false)
  const [phase, setPhase] = useState<"amount" | "confirm" | "working">("amount")
  const [priced, setPriced] = useState<{
    key: string
    quote?: SheetQuote
    error?: string
  } | null>(null)
  const [quoting, setQuoting] = useState(false)
  /** Why the review shows figures other than the ones confirmed. */
  const [requoted, setRequoted] = useState<string>()
  // A move in needs the terms accepted here, each time; a move out is the user's own funds coming back.
  const [accepted, setAccepted] = useState(false)
  const termsNeeded = direction === "in" && !accepted
  const left = useRef(false)
  /** The move this sheet runs: its operation, and the cancel its build honors. */
  const [running, setRunning] = useState<{ operationId: string; cancel: AbortController }>()
  // The burn sequence seeds the burn's record just before the burn: past it a cancel is too late.
  const seeded = useStore(session.withdrawals.list, ({ records }) =>
    records.some((r) => r.operationId === running?.operationId),
  )
  const outcome = useProvingOutcome("savings")
  const busy = useUserFlowActive()
  const busyLabel = useBusyLabel()
  const unsponsored = useSponsoredActionBlock(phase === "confirm")
  const timing = useSavingsMoveTiming()

  const from = direction === "in" ? copy.main : copy.savings
  const to = direction === "in" ? copy.savings : copy.main
  const available = direction === "in" ? wallet.main?.atomic ?? 0n : worth ?? 0n
  const availableKnown = direction === "in" ? wallet.readThisSession : position !== null
  const maxShares = position ? sharesBurnMax(position.shares, savingsCap) : undefined
  // MAX moving in stops at Main's withdrawal limit; moving out, at the per-burn share maximum.
  const maxValue =
    direction === "in"
      ? withdrawalMaxAtomic(available, txAmountCap) ?? 0n
      : position && worth !== undefined && maxShares !== undefined && position.shares > 0n
      ? (worth * maxShares) / position.shares
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
      : position && worth !== undefined
      ? sharesFor({ shares: position.shares, value: worth }, valueAtomic)
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
      ? withdrawalLimitProblem(burnAtomic, txAmountCap)
      : sharesBurnLimitProblem(burnAtomic, savingsCap)
  // The line is in the key: a quote of one line never prices a move out of another.
  const key =
    burnAtomic === undefined
      ? ""
      : `${line?.id}:${direction}:${burnAtomic}:${feeOnTop ? "top" : "off"}`

  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (
      !key ||
      burnAtomic === undefined ||
      burnAtomic <= 0n ||
      overspent ||
      assetDecimals === undefined
    ) {
      setPriced(null)
      setQuoting(false)
      return
    }
    const stale = new AbortController()
    setQuoting(true)
    const quoteOf = async (amount: bigint) => {
      if (!line || !session.moveQuote) throw new WalletError("invariant", "a move without Savings")
      const quote = await session.moveQuote(line.id, direction, amount).read(stale.signal)
      return sheetQuote(direction, amount, quote, assetDecimals)
    }
    const priceMove = async () => {
      if (!feeOnTop) return quoteOf(burnAtomic)
      // Burn the shortfall on top until the net lands at the typed figure; fees can move between quotes.
      let gross = burnAtomic
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const result = await quoteOf(gross)
          if (result.net >= burnAtomic) return result
          gross += burnAtomic - result.net
        } catch (err) {
          const tips = tipsOf(err)
          if (tips === undefined) throw err
          gross = burnAtomic + tips
        }
      }
      throw new WalletError("savings.feeUnsettled")
    }
    // eslint-disable-next-line local/timer-in-view -- debt
    const timer = setTimeout(() => {
      priceMove()
        .then(
          (result) => {
            if (!stale.signal.aborted) setPriced({ key, quote: result })
          },
          (err: unknown) =>
            !stale.signal.aborted &&
            setPriced({
              key,
              error: (() => {
                const tips = tipsOf(err)
                const fee =
                  tips === undefined || direction === "in" || !position || worth === undefined
                    ? tips
                    : (tips * worth) / (position.shares || 1n)
                return fee === undefined
                  ? FEE_UNAVAILABLE_COPY
                  : fmt(copy.feeNotCovered, { fee: usdAtomic(fee) })
              })(),
            }),
        )
        .finally(() => !stale.signal.aborted && setQuoting(false))
    }, QUOTE_DEBOUNCE_MS)
    return () => {
      stale.abort()
      clearTimeout(timer)
    }
  }, [
    key,
    direction,
    burnAtomic,
    overspent,
    feeOnTop,
    session,
    line,
    position,
    worth,
    assetDecimals,
  ])

  const current = priced?.key === key ? priced : null
  const quoted = current?.quote
  // Once priced, what Main burns is the quote's amount: the typed figure plus the fee on a move in.
  const feeOverspent =
    feeOnTop && availableKnown && quoted !== undefined && quoted.amount > available
  const grossLimitProblem =
    feeOnTop && quoted !== undefined
      ? withdrawalLimitProblem(quoted.amount, txAmountCap)
      : undefined
  const payback =
    direction === "in" && quoted && position?.rate !== undefined
      ? savingsPaybackYears(quoted.net, quoted.fee, position.rate)
      : undefined
  const paybackLine =
    payback !== undefined &&
    Number.isFinite(payback) &&
    position?.rate !== undefined &&
    quoted &&
    quoted.fee > 0n
      ? fmt(copy.payback.line, {
          apy: apyPercent(position.rate),
          time: paybackLabel(payback),
          fee: usdAtomic(quoted.fee),
        })
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
    if (!valid || quoted === undefined || !line) return
    outcome.start("building")
    setRequoted(undefined)
    setPhase("working")
    const operationId = moveOperationId()
    const cancel = new AbortController()
    setRunning({ operationId, cancel })
    try {
      const moves = await session.moveCommands?.ready()
      if (!moves) throw new WalletError("account.locked", "moves need a signed-in account")
      const move = direction === "in" ? moves.add : moves.withdraw
      await move(line.id, quoted.amount, operationId, quoted.quote, cancel.signal)
      outcome.finish()
      if (!left.current) onClose()
    } catch (e) {
      // A cancel taken after the burn went out stops nothing: what the burn then throws is shown.
      const cancelled = cancel.signal.aborted && failureCodeOf(e) === "aborted"
      if (cancelled || isPasskeyCancelled(e)) {
        outcome.cancel()
        setPhase("confirm")
        return
      }
      outcome.finish()
      if (e instanceof WalletError && e.code === "move.quoteChanged") {
        if (left.current) return
        const entry = session.moveQuote?.(line.id, direction, quoted.amount)
        entry?.refresh()
        const now = entry && (await bestEffort("unknown", entry.read()))
        if (now && assetDecimals !== undefined) {
          const next = sheetQuote(direction, quoted.amount, now, assetDecimals)
          setPriced({ key, quote: next })
          setRequoted(fmt(copy.quoteChanged, { fee: usdAtomic(next.fee) }))
        }
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
      label={copy.label}
      className={phase === "confirm" ? "ww-deposit-warning ww-sheet--detail" : "ww-deposit-warning"}
      onClose={dismiss}
    >
      {phase !== "working" && (
        <>
          <div className="ww-deposit-warning__close">
            <TopNavIconButton icon="x" ariaLabel={copy.close} onClick={dismiss} />
          </div>
          {phase === "confirm" && (
            <span className="ww-deposit__connect-icon">
              <Icon name="earn" size={24} color="#fff" />
            </span>
          )}
          <GradientText size={24} weight={700}>
            {direction === "in" ? copy.title.in : copy.title.out}
          </GradientText>
        </>
      )}

      {phase === "amount" && (
        <>
          <div className="ww-fund__fields">
            <div className={styles.moveRoute}>
              <span>
                <small>{copy.from}</small>
                <b>{from}</b>
              </span>
              <button
                type="button"
                className={`zkm-btn-reset ${styles.moveSwap}`}
                aria-label={copy.swap}
                disabled={savings.line?.exitOnly}
                onClick={() => {
                  setDirection(direction === "in" ? "out" : "in")
                  setMaxed(false)
                }}
              >
                <Icon name="payments-arrows-horizontal" size={16} />
              </button>
              <span>
                <small>{copy.to}</small>
                <b>{to}</b>
              </span>
            </div>
            <span className="ww-fund__label ww-withdraw__amount-label">
              <span>{copy.amountToMove}</span>
              <span>
                {copy.available} <b>{availableKnown ? usdAtomicFloor(available) : "—"}</b>
              </span>
            </span>
            <label className="ww-deposit__input ww-fund__amount">
              <span>
                <input
                  aria-label={copy.amountToMove}
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
                  {copy.max}
                </button>
              </span>
            </label>
            {overspent ? (
              <span className="ww-pay__error">{copy.overspent}</span>
            ) : feeOverspent ? (
              <span className="ww-pay__error">
                {fmt(copy.feeOverspent, { amount: usdAtomic(quoted!.amount) })}
              </span>
            ) : limitProblem ?? grossLimitProblem ? (
              <LimitNotice
                operation="move"
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
              <span>{copy.l1Fee}</span>
              <b style={{ fontSize: 14 }}>{figure(quoted?.fee)}</b>
            </div>
            <ProtocolFeeNote
              fee={quoting ? undefined : quoted?.quote.withdrawalFee}
              beneficiary={quoted?.quote.feeBeneficiary}
            />
            <div className="ww-deposit__input ww-sheet__fact">
              {feeOnTop ? (
                <>
                  <span>{fmt(copy.pays, { account: from })}</span>
                  <b style={{ fontSize: 14 }}>{figure(quoted?.value)}</b>
                </>
              ) : (
                <>
                  <span>{fmt(copy.receives, { account: to })}</span>
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
                <Spinner size={12} color="currentColor" /> {copy.gettingFee}
              </p>
            )}
            {direction === "in" && (
              <p className="ww-sheet__note">
                {position?.rate !== undefined
                  ? fmt(copy.apy, { apy: apyPercent(position.rate) })
                  : copy.rateUnavailable}
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
            title={copy.review}
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
              <DepositFact label={copy.from}>
                <b>{from}</b>
              </DepositFact>
              <DepositFact label={copy.to}>
                <b>{to}</b>
              </DepositFact>
              <DepositFact label={copy.amount}>
                <b>{exact(feeOnTop ? quoted?.net : quoted?.value)}</b>
              </DepositFact>
              <DepositFact label={copy.l1Fee}>
                <b>{exact(quoted?.fee)}</b>
              </DepositFact>
              <ProtocolFeeNote
                fee={quoting ? undefined : quoted?.quote.withdrawalFee}
                beneficiary={quoted?.quote.feeBeneficiary}
              />
              <hr className="ww-divider" />
              {feeOnTop ? (
                <DepositFact label={fmt(copy.pays, { account: from })}>
                  <b>{exact(quoted?.value)}</b>
                </DepositFact>
              ) : (
                <DepositFact label={fmt(copy.receives, { account: to })}>
                  <b>≈ {exact(quoted?.net)}</b>
                </DepositFact>
              )}
              <DepositFact label={copy.estimatedTime}>
                <b>{moveEstimate(timing, Date.now())}</b>
              </DepositFact>
            </div>
            {(overspent || feeOverspent) && <span className="ww-pay__error">{copy.overspent}</span>}
            {current?.error && <span className="ww-pay__error">{current.error}</span>}
            {requoted && <Warning tone="warning" title={requoted} />}
            <p className="ww-sheet__note">{copy.keepOpen}</p>
            {direction === "in" && (
              <SavingsTermsAccept accepted={accepted} onChange={setAccepted} />
            )}
          </div>
          <SponsoredActionNotice reason={unsponsored} />
          <PrimaryGradientButton
            title={busy ? busyLabel : copy.confirm}
            isDisabled={!valid || busy || !!unsponsored || termsNeeded}
            onClick={run}
            style={{ width: "100%" }}
          />
        </>
      )}

      {phase === "working" && (
        <OperationHandOff
          onLeave={leave}
          onCancel={running && !seeded ? () => running.cancel.abort() : undefined}
        />
      )}
    </Modal>
  )
}
