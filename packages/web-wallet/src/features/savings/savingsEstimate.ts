/**
 * The Savings figure between reads: the last read value carried to now at the rate, ticking under
 * the cents while the page shows it, with as many digits as it takes to see it move. Ported from
 * Harry's #2198 (`EARN_ESTIMATE_TICK_MS`, `splitTicking`).
 */
import {
  memoryStore,
  projectValueAtomic,
  useStore,
  type SavingsPosition,
} from "@obsidion/front-core"
import { usdAtomicFloor } from "../../ui/format"
import { useSession } from "../../session/session"

/** Tick while funded with a rate: the micro-cent estimate moves, so must the figure. */
export const SAVINGS_ESTIMATE_TICK_MS = 120
export const ESTIMATE_TITLE = "Estimated at today's rate, refreshes with the network"

const ATOMIC_PER_DOLLAR = 10n ** 18n
const MIN_TICKING_DIGITS = 4
const MAX_TICKING_DIGITS = 7

/**
 * How many digits tick under a figure: enough that the last one turns at least about once a second
 * at 3% APY, one more per tenfold the value shrinks. Four (micro-dollars) from $1,000 up, seven
 * (nano-dollars) under $10; a value under $1 keeps seven.
 */
export function tickingDigits(atomic: bigint): number {
  const dollars = String(atomic > 0n ? atomic / ATOMIC_PER_DOLLAR : 0n).length
  return Math.min(MAX_TICKING_DIGITS, Math.max(MIN_TICKING_DIGITS, 8 - dollars))
}

/** A value split into the two-decimal figure and the digits that tick beneath it; floored. */
export function splitTicking(atomic: bigint): { whole: string; ticking: string } {
  const value = atomic > 0n ? atomic : 0n
  const digits = tickingDigits(value)
  const unit = 10n ** BigInt(16 - digits)
  return {
    whole: usdAtomicFloor(value),
    ticking: String((value / unit) % 10n ** BigInt(digits)).padStart(digits, "0"),
  }
}

export interface SavingsEstimate {
  /** The value carried to now while ticking, else the last read; unknown without a position. */
  value: bigint | undefined
  /** True while the figure moves: `enabled`, funded, and a rate to carry it at. */
  ticking: boolean
}

/** Whether the figure moves: `enabled`, funded, and a rate to carry it at. */
export const ticking = (position: SavingsPosition | null, enabled: boolean): boolean =>
  !!position && enabled && position.shares > 0n && (position.apy ?? 0) > 0

/** The figure at `now`: carried at the rate while it ticks; else as read. */
export function selectSavingsEstimate(
  position: SavingsPosition | null,
  enabled: boolean,
  now: number,
): SavingsEstimate {
  if (!position) return { value: undefined, ticking: false }
  const moving = ticking(position, enabled)
  return {
    value: moving
      ? projectValueAtomic(position.value, position.readAt, now, position.apy!)
      : position.value,
    ticking: moving,
  }
}

const STILL = memoryStore(0).readonly

/**
 * The Savings value as the screen shows it, on the page's estimate clock: it ticks every
 * {@link SAVINGS_ESTIMATE_TICK_MS} while it moves and the page shows.
 */
export function useSavingsEstimate(
  position: SavingsPosition | null,
  enabled: boolean,
): SavingsEstimate {
  const { page } = useSession()
  const now = useStore(ticking(position, enabled) ? page.savingsEstimateClock : STILL)
  return selectSavingsEstimate(position, enabled, now)
}
