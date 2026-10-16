import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { projectSavings, projectSavingsMonthly } from "@obsidion/front-core"
import { GradientText, PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"
import { decimalInput, floorToCents } from "../../ui/format"
import { Modal } from "../../ui/Modal"

export const CALCULATOR_HORIZONS = [1, 5, 10] as const
export type CalculatorHorizon = (typeof CALCULATOR_HORIZONS)[number]

/** `5.5%` from a yearly fraction. */
export const apyPercent = (apy: number) => `${(apy * 100).toFixed(1)}%`

/** A yearly fraction from what a user typed as a percent: `3.8`, `3.8%`, `3,8`; clamped 0–100. */
export function parseApyPercent(text: string): number {
  const percent = Number.parseFloat(text.replace(",", ".").replace(/[^\d.-]/g, ""))
  return Math.min(100, Math.max(0, percent || 0)) / 100
}

/** Under a dollar is dust: the calculator starts from a balance only above it. */
const CALCULATOR_DUST = 10n ** BigInt(DEFAULT_DECIMALS)
const DEFAULT_START = 500

/** A bar's room for its label: a year's value label, or a month's three letters. The chart's gap between bars. */
const BAR_MIN_YEAR = 52
const BAR_MIN_MONTH = 28
const BAR_GAP = 8

/** One step of the chart and table: a month over the one-year horizon, a year beyond. */
export interface CalculatorStep {
  label: string
  added: number
  earned: number
  balance: number
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]

/**
 * The steps for a horizon: twelve months, named from next month on, over one year; else one per
 * year, "Year N". The twelfth month is the one-year figure: both read the same projection.
 */
export function calculatorSteps(
  start: number,
  monthly: number,
  horizon: CalculatorHorizon,
  apy: number,
  now = Date.now(),
): CalculatorStep[] {
  if (horizon === 1) {
    const thisMonth = new Date(now).getMonth()
    return projectSavingsMonthly(start, monthly, 12, apy).map(({ month, ...rest }) => ({
      label: MONTH_NAMES[(thisMonth + month) % 12],
      ...rest,
    }))
  }
  return projectSavings(start, monthly, horizon, apy).map(({ year, ...rest }) => ({
    label: `Year ${year}`,
    ...rest,
  }))
}
/** Years a bar may stand for, smallest first. */
const GROUP_SIZES = [1, 2, 4, 5, 10] as const
/** How many bars `width` holds with room for their labels; always at least one. */
export const barsThatFit = (width: number, barMin = BAR_MIN_YEAR): number =>
  Math.max(1, Math.floor((width + BAR_GAP) / (barMin + BAR_GAP)))

/**
 * One step per bar while they fit `maxBars`, else one per the smallest group size that does. Each
 * group is the row of its last step; the last group ends at the horizon whatever the size.
 */
export function groupSteps<T>(rows: T[], maxBars: number): T[] {
  if (rows.length === 0) return []
  const size =
    GROUP_SIZES.find((n) => Math.ceil(rows.length / n) <= maxBars) ??
    GROUP_SIZES[GROUP_SIZES.length - 1]
  const grouped: T[] = []
  for (let end = size; end < rows.length; end += size) grouped.push(rows[end - 1])
  grouped.push(rows[rows.length - 1])
  return grouped
}

/** Pixels an 11 px value label needs, by its characters. */
const labelWidth = (text: string) => text.length * 6.5

/** The balances the calculator may start from, in base units; unknown while unread. */
export interface CalculatorBalances {
  /** The Savings position's value. */
  savings?: bigint
  /** Main's DAI. */
  main?: bigint
}

/**
 * The starting amount: the Savings balance, else Main's DAI, each to the cent and only above dust;
 * else the default.
 */
export function calculatorStart(balances: CalculatorBalances = {}): number {
  for (const balance of [balances.savings, balances.main]) {
    if (balance !== undefined && balance >= CALCULATOR_DUST) {
      return Number(floorToCents(balance, DEFAULT_DECIMALS))
    }
  }
  return DEFAULT_START
}

const whole = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`
const years = (n: number) => `${n} ${n === 1 ? "year" : "years"}`

function AmountField({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (n: number) => void
}) {
  // What the user is typing, to the cent, shown as typed until the field blurs.
  const [draft, setDraft] = useState<string>()
  return (
    <label className="ww-calc__field">
      <span>{label}</span>
      <span className="ww-calc__box">
        <input
          inputMode="decimal"
          aria-label={label}
          value={`$${draft ?? value}`}
          onChange={(e) => {
            const text = decimalInput(e.target.value.replace(/[$,\s]/g, ""))
            if (!/^\d*(\.\d{0,2})?$/.test(text)) return
            setDraft(text)
            onChange(Math.min(1_000_000_000, Number(text) || 0))
          }}
          onBlur={() => setDraft(undefined)}
        />
        <small>USD</small>
      </span>
    </label>
  )
}

/** What a start amount and a monthly top-up grow to at today's rate, year by year. */
export function EarningsCalculator({
  apy,
  balances,
  onMove,
}: {
  apy: number | undefined
  balances?: CalculatorBalances
  onMove: (amount: number) => void
}) {
  const [start, setStart] = useState(() => calculatorStart(balances))
  // A balance read after the sheet opened still fills the field, until the user has typed in it.
  const touched = useRef(false)
  useEffect(() => {
    if (!touched.current) setStart(calculatorStart(balances))
  }, [balances?.savings, balances?.main]) // eslint-disable-line react-hooks/exhaustive-deps
  const [monthly, setMonthly] = useState(50)
  // The assumed rate follows the live APY until the user types one; Reset hands it back.
  const [rate, setRate] = useState(apy)
  const [rateTouched, setRateTouched] = useState(false)
  useEffect(() => {
    if (!rateTouched) setRate(apy)
  }, [apy, rateTouched])
  // What the user is typing, shown as typed until the field blurs.
  const [rateDraft, setRateDraft] = useState<string>()
  const [horizon, setHorizon] = useState<CalculatorHorizon>(5)
  const rows = calculatorSteps(start, monthly, horizon, rate ?? 0)
  const barMin = horizon === 1 ? BAR_MIN_MONTH : BAR_MIN_YEAR
  // The chart's width decides how many bars it holds; until measured, a phone's five.
  const chart = useRef<HTMLDivElement>(null)
  const [chartWidth, setChartWidth] = useState<number>()
  useLayoutEffect(() => {
    const element = chart.current
    if (!element || typeof ResizeObserver === "undefined") return
    const measure = () => setChartWidth(element.clientWidth || undefined)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const groups = groupSteps(rows, chartWidth === undefined ? 5 : barsThatFit(chartWidth, barMin))
  const barWidth =
    chartWidth === undefined ? barMin : (chartWidth - BAR_GAP * (groups.length - 1)) / groups.length
  // A label every bar while they fit, else every second, third, …; the last bar keeps its label.
  const labelStep = Math.max(
    1,
    Math.ceil(Math.max(...groups.map((row) => labelWidth(whole(row.balance)))) / barWidth),
  )
  const last = rows[rows.length - 1]
  const peak = Math.max(last.balance, 1)
  // Same at the shown precision counts as the current rate, so the note never names it twice.
  const current = apy === undefined ? undefined : apyPercent(apy)
  const assumedIsCurrent =
    rate === undefined || (current !== undefined && apyPercent(rate) === current)
  return (
    <div className="ww-calc">
      <div className="ww-calc__fields">
        <AmountField
          label="Starting amount"
          value={start}
          onChange={(n) => {
            touched.current = true
            setStart(n)
          }}
        />
        <AmountField label="Monthly top-up" value={monthly} onChange={setMonthly} />
        {/* Not one wrapping label: the Reset button must not sit inside the input's. */}
        <div className="ww-calc__field">
          <label htmlFor="ww-calc-rate">Assumed APY</label>
          <span className="ww-calc__box">
            <input
              id="ww-calc-rate"
              inputMode="decimal"
              aria-label="Assumed APY"
              value={rateDraft ?? (rate === undefined ? "—" : apyPercent(rate))}
              onChange={(e) => {
                setRateTouched(true)
                setRateDraft(e.target.value)
                setRate(parseApyPercent(e.target.value))
              }}
              onBlur={() => setRateDraft(undefined)}
            />
            {rateTouched ? (
              <button
                type="button"
                className="zkm-btn-reset ww-calc__reset"
                onClick={() => {
                  setRateTouched(false)
                  setRateDraft(undefined)
                  setRate(apy)
                }}
              >
                Reset
              </button>
            ) : (
              apy !== undefined && <small>current</small>
            )}
          </span>
        </div>
      </div>
      <div className="ww-calc__horizon" role="group" aria-label="Horizon">
        {CALCULATOR_HORIZONS.map((h) => (
          <button
            key={h}
            type="button"
            className="zkm-btn-reset"
            aria-pressed={horizon === h}
            onClick={() => setHorizon(h)}
          >
            {years(h)}
          </button>
        ))}
      </div>
      <div className="ww-calc__result">
        <small>In {years(horizon)} you'd have</small>
        <b data-testid="calculator-total">{whole(last.balance)}</b>
        <span className="ww-calc__legend">
          <i data-kind="added" /> You add {whole(last.added)}
          <i data-kind="earned" /> You earn {whole(last.earned)}
        </span>
      </div>
      <div
        ref={chart}
        className="ww-calc__bars"
        role="img"
        aria-label={`Balance by ${horizon === 1 ? "month" : "year"} over ${years(horizon)}`}
      >
        {groups.map((row, index) => (
          <div
            className="ww-calc__bar"
            key={row.label}
            style={{ height: `${(100 * row.balance) / peak}%` }}
          >
            <span>
              {(groups.length - 1 - index) % labelStep === 0 ? whole(row.balance) : "\u00a0"}
            </span>
            <i data-kind="earned" style={{ flexGrow: row.earned }} />
            <i data-kind="added" style={{ flexGrow: row.added }} />
            <small>{row.label}</small>
          </div>
        ))}
      </div>
      <table className="ww-calc__table">
        <thead>
          <tr>
            <th>{horizon === 1 ? "Month" : "Year"}</th>
            <th>Added</th>
            <th>Earned</th>
            <th>Balance</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td>{whole(row.added)}</td>
              <td>
                <em>+{whole(row.earned)}</em>
              </td>
              <td>{whole(row.balance)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="ww-sheet__note">
        {assumedIsCurrent ? (
          <>
            Projection assumes the current {current ? `${current} APY` : "rate"} holds and rewards
            compound every block. The rate is variable, so real earnings will differ.
          </>
        ) : (
          <>
            Projection assumes {apyPercent(rate ?? 0)} APY holds and rewards compound every block.{" "}
            {current === undefined ? "The rate" : `The current rate is ${current}; it`} is variable,
            so real earnings will differ.
          </>
        )}
      </p>
      <PrimaryGradientButton
        title={`Add ${whole(start)} to Savings`}
        isDisabled={start <= 0}
        onClick={() => onMove(start)}
        style={{ width: "100%" }}
      />
    </div>
  )
}

/** The calculator's year-by-year sheet. `onMove` carries the start amount into a move. */
export function EarningsCalculatorSheet({
  apy,
  balances,
  onMove,
  onClose,
}: {
  apy: number | undefined
  balances?: CalculatorBalances
  onMove: (amount: number) => void
  onClose: () => void
}) {
  return (
    <Modal
      variant="bare"
      label="Earnings calculator"
      className="ww-deposit-warning ww-sheet--detail ww-savings-sheet"
      onClose={onClose}
    >
      <div className="ww-deposit-warning__close">
        <TopNavIconButton icon="x" ariaLabel="Close" onClick={onClose} />
      </div>
      <div className="ww-savings-sheet__body">
        <GradientText size={24} weight={700}>
          Earnings calculator
        </GradientText>
        <EarningsCalculator apy={apy} balances={balances} onMove={onMove} />
      </div>
    </Modal>
  )
}
