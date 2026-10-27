/**
 * Boot order for an account whose L1 record still waits for its upgrade: the old versions' probe
 * runs first, and the v6 balance sync waits for it, so the two do not share the CPU and network.
 * Each wait is capped, so a slow L1 read or probe cannot hold the v6 wallet.
 */
import { bootPriority } from "@obsidion/front-core"

/** How long the v6 sync waits for the record check to answer. */
export const RECORD_CHECK_WAIT_MS = 3_000
/** How long the v6 sync waits for the probe of a stale-record account. */
export const PROBE_FIRST_WAIT_MS = 30_000

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), ms)))
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** One wallet per page load, as `bootPriority`. */
export class UpgradeFirst {
  private readonly stale = deferred<boolean>()
  private readonly probed = deferred<void>()

  /** Whether the old versions go first: the first answer holds; a failed check answers false. */
  recordChecked(stale: boolean): void {
    this.stale.resolve(stale)
  }

  /** The boot probe answered or failed. */
  probeAnswered(): void {
    this.probed.resolve()
  }

  /** Resolves when the probe may start: at once for a stale record, else at its boot stage. */
  probeMayStart(): Promise<void> {
    return Promise.race([
      bootPriority.whenReady("migrationProbe"),
      this.stale.promise.then((stale) => (stale ? undefined : new Promise<void>(() => {}))),
    ])
  }

  /** Resolves when the v6 balance sync may start: after the probe for a stale record. */
  async v6MayStart(): Promise<void> {
    if (await within(this.stale.promise, RECORD_CHECK_WAIT_MS, false))
      await within(this.probed.promise, PROBE_FIRST_WAIT_MS, undefined)
  }
}

export const upgradeFirst = new UpgradeFirst()
