/**
 * When this device's next burn lands on L1, from how long its recent burns took from confirm to
 * mined. A burn's L2 receipt means its checkpoint is on L1, so that is the whole wait. Proving runs
 * in the browser, so the time depends on the device.
 */
import { bestEffort, type BurnDurations, type BurnLanding } from "@obsidion/front-core"

/** Before the device has a history: wide enough for a slow phone. */
export const DEFAULT_BURN_LANDING: BurnLanding = { expected: 180, earliest: 60, latest: 600 }

/** A lost sample only widens the next window. */
export async function recordBurnDuration(durations: BurnDurations, ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return
  await bestEffort("unknown", durations.add(ms / 1000))
}

export async function burnLanding(durations: BurnDurations): Promise<BurnLanding> {
  const seconds = [...((await bestEffort("unknown", durations.samples())) ?? [])].sort(
    (a, b) => a - b,
  )
  if (seconds.length === 0) return DEFAULT_BURN_LANDING
  const median = seconds[seconds.length >> 1]!
  return {
    expected: median,
    earliest: seconds[0]!,
    // Few samples and a busy device run slower than the slowest seen.
    latest: seconds[seconds.length - 1]! * 1.5,
  }
}
