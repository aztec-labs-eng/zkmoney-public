import type { ObsidionWallet } from "@obsidion/sdk"
import { getSipaDepositGateway } from "./sipaGateway"

/**
 * The one scheduler of observe-only passes. Screens that watch a deposit address read its rail
 * record; while one watches, the observed account is read every 4 s. A pass reads only the head
 * until a new block lands, so a watched tick costs one cheap read.
 */
const WATCH_INTERVAL_MS = 4_000

/** The account whose SIPAs are observed, and its own cadence without a watching screen. */
interface Observed {
  wallet: ObsidionWallet
  recipient: string
  intervalMs?: number
}

const observed: Observed[] = []
const listeners = new Set<() => void>()
let watchers = 0
let timer: ReturnType<typeof setTimeout> | undefined
let inFlight: Promise<void> | undefined
let landedAt: number | undefined

/**
 * Observes `recipient`'s SIPAs through `wallet` while watched, and every `intervalMs` without a
 * watch when given. The latest call is the one observed. Returns the release.
 */
export function observeDeposits(
  wallet: ObsidionWallet,
  recipient: string,
  intervalMs?: number,
): () => void {
  const entry = { wallet, recipient, intervalMs }
  observed.push(entry)
  if (watchers > 0 || intervalMs !== undefined) void tick()
  return () => {
    const at = observed.indexOf(entry)
    if (at >= 0) observed.splice(at, 1)
    schedule()
  }
}

/** Observes on the watch cadence while any screen holds a watch. Returns the release. */
export function watchDeposits(): () => void {
  watchers += 1
  if (watchers === 1) void tick()
  let released = false
  return () => {
    if (released) return
    released = true
    watchers -= 1
    schedule()
  }
}

/** A pass read the chain: its time is what watching screens show as last checked. */
export function notePassLanded(at: number = Date.now()): void {
  landedAt = at
  for (const listener of listeners) listener()
}

export function lastPassAt(): number | undefined {
  return landedAt
}

export function subscribePasses(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** An observe pass now, or the one in flight. Rejects when it fails; settles at once with nothing observed. */
export function observeNow(): Promise<void> {
  const target = observed.at(-1)
  if (!target) return Promise.resolve()
  inFlight ??= getSipaDepositGateway()
    .observe(target.wallet, target.recipient)
    .then((result) => {
      if (result) notePassLanded()
    })
    .finally(() => {
      inFlight = undefined
    })
  return inFlight
}

function schedule(): void {
  clearTimeout(timer)
  const interval = watchers > 0 ? WATCH_INTERVAL_MS : observed.at(-1)?.intervalMs
  if (interval !== undefined && observed.length > 0) timer = setTimeout(() => void tick(), interval)
}

async function tick(): Promise<void> {
  clearTimeout(timer)
  try {
    await observeNow()
  } catch (err) {
    console.warn("[deposit] observe pass failed (will retry):", err)
  }
  schedule()
}

export function resetDepositPassesForTests(): void {
  observed.length = 0
  listeners.clear()
  watchers = 0
  clearTimeout(timer)
  inFlight = undefined
  landedAt = undefined
}
