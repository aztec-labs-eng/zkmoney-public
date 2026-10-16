/**
 * The Savings figure between reads: the last read value carried to now at the rate, ticking under
 * the cents while the page shows it, with as many digits as it takes to see it move. Ported from
 * Harry's #2198 (`EARN_ESTIMATE_TICK_MS`, `splitTicking`).
 */
import { useEffect, useState } from "react"
import { projectValueAtomic, type SavingsPosition } from "@obsidion/front-core"
import { usdAtomicFloor } from "../../ui/format"
import { pauseWhenHidden } from "../../platform/visibilityScheduler"

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

/**
 * The Savings value as the screen shows it. It ticks every {@link SAVINGS_ESTIMATE_TICK_MS} while
 * `enabled` and the position is funded with a rate, pauses with the page hidden, and reads plain
 * otherwise.
 */
export function useSavingsEstimate(
  position: SavingsPosition | null,
  enabled: boolean,
): SavingsEstimate {
  const ticking = enabled && position !== null && position.shares > 0n && (position.apy ?? 0) > 0
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const id = pauseWhenHidden.setInterval(() => setNow(Date.now()), SAVINGS_ESTIMATE_TICK_MS)
    return () => pauseWhenHidden.clearInterval(id)
  }, [ticking])
  if (!position) return { value: undefined, ticking: false }
  return {
    value: ticking
      ? projectValueAtomic(position.value, position.readAt, now, position.apy!)
      : position.value,
    ticking,
  }
}
