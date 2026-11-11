import type { OxideEnvTuple } from "@obsidion/core/types"
import type { Address } from "viem"
import type { WebWalletConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"
import { portalContract } from "../token/oxideToken"
import type { Pace } from "@obsidion/core/cadence"

/** How often a live portal of another generation is checked for its freeze. */
export const FREEZE_POLL_MS = 30_000

/**
 * Calls `onFrozen` once, when any of `portals` freezes. A freeze is one-shot, so the watch then
 * stops. A failed read is retried at the next poll. Returns the stop function.
 */
export function watchForFreeze(
  config: WebWalletConfig,
  tuples: readonly OxideEnvTuple[],
  onFrozen: () => void,
  pace: Pick<Pace, "every">,
  intervalMs = FREEZE_POLL_MS,
  isFrozen = (tuple: OxideEnvTuple) =>
    portalContract(l1PublicClient(config), tuple.portal as Address).isFrozen(),
): () => void {
  let stopped = false
  const poll = async () => {
    const frozen = await Promise.all(tuples.map((t) => isFrozen(t).catch(() => false)))
    if (stopped || !frozen.some(Boolean)) return
    stop()
    onFrozen()
  }
  const id = pace.every(intervalMs, poll)
  const stop = () => {
    stopped = true
    id()
  }
  return stop
}

/**
 * The manifest could not be read now: a network error that the user can do nothing about. It never
 * shows as an error. The previous state stays, and a later read tries again.
 */
export class ManifestUnavailableError extends Error {
  constructor(cause: unknown) {
    super("The oxide manifest could not be read", { cause })
    this.name = "ManifestUnavailableError"
  }
}

/** Waits `ms`, or until `signal` aborts, which rejects. */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", stop)
      resolve()
    }
    const stop = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    const timer = setTimeout(done, ms)
    if (signal?.aborted) stop()
    else signal?.addEventListener("abort", stop, { once: true })
  })
}

/**
 * While a frozen source waits for its destination's migration feature: on each poll, `routed` reads
 * the manifest again and tells whether a waiting source has a usable route now. Only then is
 * `onRoute` called, which probes again. A poll is skipped while the last one is in flight, and a
 * failed read is tried again at the next poll. Returns the stop function; the caller stops it once
 * no source waits.
 */
export function watchForFeature(
  routed: () => Promise<boolean>,
  onRoute: () => void,
  pace: Pick<Pace, "every">,
  intervalMs = FREEZE_POLL_MS,
): () => void {
  let stopped = false
  let reading = false
  const poll = async () => {
    if (reading) return
    reading = true
    try {
      if ((await routed()) && !stopped) onRoute()
    } catch (error) {
      console.warn("[migration] the migration feature check failed:", error)
    } finally {
      reading = false
    }
  }
  const id = pace.every(intervalMs, poll)
  return () => {
    stopped = true
    id()
  }
}
