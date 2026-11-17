/**
 * The Savings figure between reads: the last read value carried to now at the rate, ticking under
 * the cents while the page shows it, with as many digits as it takes to see it move. Ported from
 * Harry's #2198 (`EARN_ESTIMATE_TICK_MS`, `splitTicking`).
 */
import { assetUsd, memoryStore, projectValueAtomic, useStore } from "@obsidion/front-core"
import { usdAtomicFloor } from "../../ui/format"
import { useSession } from "../../session/session"
import {
  savingsTotal,
  selectSavingsEarned,
  type SavingsLine,
  type SavingsPosition,
} from "./savingsLine"

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
  /** Savings' worth, carried to now while ticking, else as last read; unknown as the total is. */
  value: bigint | undefined
  /** What Savings has earned at that worth; unknown as `selectSavingsEarned` is. */
  earned: bigint | undefined
  /** True while the figure moves: `enabled`, and a funded line with a rate to carry it at. */
  ticking: boolean
}

const moving = (position: SavingsPosition | null): boolean =>
  !!position && position.shares > 0n && (position.rate ?? 0n) > 0n

/** Whether the figure moves: `enabled`, the total known, and a funded line with a rate. */
export const ticking = (savings: SavingsLine, enabled: boolean): boolean =>
  enabled &&
  savingsTotal(savings) !== undefined &&
  savings.lines.some(({ position }) => moving(position))

/** The figures at `now`: each line carried at its own rate while they tick; else as read. */
export function selectSavingsEstimate(
  savings: SavingsLine,
  enabled: boolean,
  now: number,
): SavingsEstimate {
  const carried = ticking(savings, enabled)
  const usdOf = (position: SavingsPosition) => {
    const read = assetUsd(position.value, position)
    return carried && moving(position)
      ? projectValueAtomic(read, position.readAt, now, position.rate!)
      : read
  }
  return {
    value: savingsTotal(savings, usdOf),
    earned: selectSavingsEarned(savings, usdOf),
    ticking: carried,
  }
}

const STILL = memoryStore(0).readonly

/**
 * Savings' figures as the screen shows them, on the page's estimate clock: they tick every
 * {@link SAVINGS_ESTIMATE_TICK_MS} while they move and the page shows.
 */
export function useSavingsEstimate(savings: SavingsLine, enabled: boolean): SavingsEstimate {
  const { page } = useSession()
  const now = useStore(ticking(savings, enabled) ? page.savingsEstimateClock : STILL)
  return selectSavingsEstimate(savings, enabled, now)
}
