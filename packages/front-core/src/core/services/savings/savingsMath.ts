// The calculator's arithmetic, after Harry's earnMath (#2198). `apy` is a yearly fraction.

const RAY = 10n ** 27n
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60
/** One sUSDS share, 18 decimals; a share price is the assets this many shares redeem for. */
export const SHARE = 10n ** 18n

/** What `shares` redeem for at `sharePrice`, the vault's assets per `SHARE`. */
export const savingsValue = (shares: bigint, sharePrice: bigint): bigint =>
  (shares * sharePrice) / SHARE

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000

/**
 * Years until `net` earns back `fee` at `apy`: `net × ((1 + apy)^t − 1) = fee`. Infinite with no
 * rate, nothing to grow, or a fee it can never reach; zero without a fee.
 */
export function savingsPaybackYears(net: bigint, fee: bigint, apy: number): number {
  if (fee <= 0n) return 0
  if (net <= 0n || !(apy > 0)) return Infinity
  return Math.log1p(Number(fee) / Number(net)) / Math.log1p(apy)
}

/**
 * `valueAtomic` carried from `readAt` to `now` at `apy`: the between-reads estimate behind the
 * ticking figure. A rate at or below zero, or an unknown one, projects nothing. (Harry's, #2198.)
 */
export function projectValueAtomic(
  valueAtomic: bigint,
  readAt: number,
  now: number,
  apy: number,
): bigint {
  const ms = now - readAt
  if (valueAtomic <= 0n || ms <= 0 || !(apy > 0)) return valueAtomic
  // Growth over a short interval is a tiny fraction; expm1/log1p keep it where pow would round it.
  const growth = Math.expm1((ms / MS_PER_YEAR) * Math.log1p(apy))
  return valueAtomic + (valueAtomic * BigInt(Math.round(growth * 1e18))) / SHARE
}

/** Sky's per-second savings rate (a ray) compounded over a year. */
export const apyFromSsr = (ssr: bigint): number =>
  Math.expm1(SECONDS_PER_YEAR * Math.log1p(Number(ssr - RAY) / 1e27))

export interface SavingsProjectionYear {
  year: number
  /** The start amount plus every top-up so far. */
  added: number
  earned: number
  balance: number
}

/** A start amount plus a monthly top-up, compounding at `apy`, at the end of each year. */
export function projectSavings(
  start: number,
  monthly: number,
  years: number,
  apy: number,
): SavingsProjectionYear[] {
  return projectSavingsMonthly(start, monthly, Math.round(years * 12), apy)
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

/** The same projection one month at a time: `apy` compounded to a twelfth, then the top-up. */
export function projectSavingsMonthly(
  start: number,
  monthly: number,
  months: number,
  apy: number,
): SavingsProjectionMonth[] {
  const rate = Math.expm1(Math.log1p(apy) / 12)
  const rows: SavingsProjectionMonth[] = []
  let balance = start
  let added = start
  for (let month = 1; month <= months; month++) {
    balance = balance * (1 + rate) + monthly
    added += monthly
    rows.push({ month, added, earned: balance - added, balance })
  }
  return rows
}
