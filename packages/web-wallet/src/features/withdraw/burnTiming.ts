/**
 * When this device's next burn lands on L1, from how long its recent burns took from confirm to
 * mined. A burn's L2 receipt means its checkpoint is on L1, so that is the whole wait. Proving runs
 * in the browser, so the time depends on the device.
 */
import type { BurnLanding, IStorageAdapter } from "@obsidion/front-core"
import { webStorage } from "../../platform/storage/WebStorageAdapter"

const KEY = "burnDurations"
const MAX_SAMPLES = 10

/** Before the device has a history: wide enough for a slow phone. */
export const DEFAULT_BURN_LANDING: BurnLanding = { expected: 180, earliest: 60, latest: 600 }

async function samples(storage: IStorageAdapter): Promise<number[]> {
  try {
    const parsed: unknown = JSON.parse((await storage.getItem(KEY)) ?? "[]")
    return Array.isArray(parsed)
      ? parsed.filter((s): s is number => Number.isFinite(s) && s > 0)
      : []
  } catch {
    return []
  }
}

export async function recordBurnDuration(ms: number, storage: IStorageAdapter = webStorage) {
  if (!Number.isFinite(ms) || ms <= 0) return
  try {
    const kept = [...(await samples(storage)), ms / 1000].slice(-MAX_SAMPLES)
    await storage.setItem(KEY, JSON.stringify(kept))
  } catch {
    // A lost sample only widens the next window.
  }
}

export async function burnLanding(storage: IStorageAdapter = webStorage): Promise<BurnLanding> {
  const seconds = (await samples(storage)).sort((a, b) => a - b)
  if (seconds.length === 0) return DEFAULT_BURN_LANDING
  const median = seconds[seconds.length >> 1]!
  return {
    expected: median,
    earliest: seconds[0]!,
    // Few samples and a busy device run slower than the slowest seen.
    latest: seconds[seconds.length - 1]! * 1.5,
  }
}
