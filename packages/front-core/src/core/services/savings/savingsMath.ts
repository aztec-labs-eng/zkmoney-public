// The calculator's arithmetic, after Harry's earnMath. `rate` is a holding's yearly rate
// at `RATE_SCALE`.
import { RATE_SCALE } from "../holdings/holdingFigures"

/** One sUSDS share, 18 decimals; a share price is the assets this many shares redeem for. */
export const SHARE = 10n ** 18n

/** What `shares` redeem for at `sharePrice`, the vault's assets per `SHARE`. */
export const savingsValue = (shares: bigint, sharePrice: bigint): bigint =>
  (shares * sharePrice) / SHARE

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000

/** The rate as a yearly fraction, for the float math of a projection. */
const yearly = (rate: bigint): number => Number(rate) / Number(RATE_SCALE)

/**
 * Years until `net` earns back `fee` at `rate`: `net × ((1 + rate)^t − 1) = fee`. Infinite with no
 * rate, nothing to grow, or a fee it can never reach; zero without a fee.
 */
export function savingsPaybackYears(net: bigint, fee: bigint, rate: bigint): number {
  if (fee <= 0n) return 0
  const apy = yearly(rate)
  if (net <= 0n || !(apy > 0)) return Infinity
  return Math.log1p(Number(fee) / Number(net)) / Math.log1p(apy)
}

/**
 * `valueAtomic` carried from `readAt` to `now` at `rate`: the between-reads estimate behind the
 * ticking figure. A rate at or below zero projects nothing. (Harry's.)
 */
export function projectValueAtomic(
  valueAtomic: bigint,
  readAt: number,
  now: number,
  rate: bigint,
): bigint {
  const apy = yearly(rate)
  const ms = now - readAt
  if (valueAtomic <= 0n || ms <= 0 || !(apy > 0)) return valueAtomic
  // Growth over a short interval is a tiny fraction; expm1/log1p keep it where pow would round it.
  const growth = Math.expm1((ms / MS_PER_YEAR) * Math.log1p(apy))
  return valueAtomic + (valueAtomic * BigInt(Math.round(growth * 1e18))) / SHARE
}

export interface SavingsProjectionYear {
  year: number
  /** The start amount plus every top-up so far. */
  added: number
  earned: number
  balance: number
}

/** A start amount plus a monthly top-up, compounding at `rate`, at the end of each year. */
export function projectSavings(
  start: number,
  monthly: number,
  years: number,
  rate: bigint,
): SavingsProjectionYear[] {
  return projectSavingsMonthly(start, monthly, Math.round(years * 12), rate)
    .filter((row) => row.month % 12 === 0)
    .map(({ month, ...rest }) => ({ year: month / 12, ...rest }))
}

export interface SavingsProjectionMonth {
  month: number
  /** The start amount plus every top-up so far. */
  added: number
  earned: number
  balance: number
}

/** The same projection one month at a time: `rate` compounded to a twelfth, then the top-up. */
export function projectSavingsMonthly(
  start: number,
  monthly: number,
  months: number,
  rate: bigint,
): SavingsProjectionMonth[] {
  const monthRate = Math.expm1(Math.log1p(yearly(rate)) / 12)
  const rows: SavingsProjectionMonth[] = []
  let balance = start
  let added = start
  for (let month = 1; month <= months; month++) {
    balance = balance * (1 + monthRate) + monthly
    added += monthly
    rows.push({ month, added, earned: balance - added, balance })
  }
  return rows
}
