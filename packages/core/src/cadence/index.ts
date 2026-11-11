/**
 * The pace of every wait on outside state: a chain read, a receipt, a service's answer. Each poll
 * names its own interval, a live network's cadence. The composition root builds one pace per page
 * and passes it in. It may cap every interval, or, where state changes only when the environment
 * says so (a test world), make every poll wait for that environment's {@link Pace.wake} with no
 * timer at all. Backoffs, grace windows and the clocks behind labels are not polls: they keep their
 * own timers. A third-party loop with a timer of its own, which no wake reaches (a viem receipt
 * wait), polls at {@link Pace.foreignMs}.
 */
export interface Pace {
  /**
   * The least time a poll leaves before it asks again, for a gate stamped ahead (a record's next
   * attempt): signalled polls ask whenever woken, so 0.
   */
  gateMs(ms: number): number
  /** The interval for a third-party loop with its own timer, which no wake reaches: never 0. */
  foreignMs(ms: number): number
  /** One poll's wait: ends after {@link Pace.gateMs}(`ms`), on a wake, or when `signal` aborts. */
  wait(ms: number, signal?: AbortSignal): Promise<void>
  /** How many wakes have come: an {@link Pace.after} given it as `since` runs at once if one came after. */
  mark(): number
  /**
   * Runs `fn` once after {@link Pace.gateMs}(`ms`), or at once on a wake, or at once if a wake came
   * after the {@link Pace.mark} `since` (one that came while the caller was busy). Returns the cancel.
   */
  after(ms: number, fn: () => void, since?: number): () => void
  /**
   * Runs `fn` every {@link Pace.gateMs}(`ms`), and at once on a wake. With timers a run does not
   * hold back the next, as setInterval: a slow run overlaps the next one. Signalled polls run one
   * at a time, the wait starting once `fn` and the promise it returns settle, so a world that
   * signals a change sees what the poll did with it; a wake that came during a run starts the next
   * one at once. A run's failure is reported as an uncaught error, as setInterval would. Returns
   * the stop.
   */
  every(ms: number, fn: () => unknown): () => void
  /** Ends every poll's current wait now: whatever it watches may have changed. */
  wake(): void
}

export interface PaceOptions {
  /** Caps every poll's interval. */
  maxMs?: number
  /** Every poll waits for a wake; a timer never ends its wait. */
  signalled?: boolean
  /** Caps {@link Pace.foreignMs} while signalled; `maxMs` caps it otherwise. */
  foreignMaxMs?: number
  /** Keeps each waiting poll's call site, for `waiting`. */
  trace?: boolean
}

/**
 * A pace over its own timers and wakes. `waiting` names where each poll waiting now was called
 * from, when tracing: with signalled polls, a step that never comes is a change nothing signalled.
 */
export function createPace(opts: PaceOptions = {}): Pace & { waiting(): string[] } {
  const { maxMs, signalled = false } = opts
  const traced = opts.trace ? new Map<() => void, string>() : undefined
  const sleepers = new Set<() => void>()
  /** Counts wakes, so a poll that was running when one came runs again rather than missing it. */
  let wakes = 0

  const gateMs = (ms: number) => {
    if (signalled) return 0
    return maxMs === undefined ? ms : Math.min(ms, maxMs)
  }

  const wait = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve()
      const done = () => {
        clearTimeout(timer)
        sleepers.delete(done)
        traced?.delete(done)
        signal?.removeEventListener("abort", done)
        resolve()
      }
      const timer = signalled ? undefined : setTimeout(done, gateMs(ms))
      sleepers.add(done)
      traced?.set(done, new Error("poll waiting").stack ?? "")
      signal?.addEventListener("abort", done)
    })

  return {
    gateMs,
    foreignMs(ms) {
      const cap = signalled ? opts.foreignMaxMs : maxMs
      return cap === undefined ? ms : Math.max(1, Math.min(ms, cap))
    },
    wait,
    mark: () => wakes,
    after(ms, fn, since) {
      const cancelled = new AbortController()
      const missed = since !== undefined && since !== wakes
      void (missed ? Promise.resolve() : wait(ms, cancelled.signal)).then(() => {
        if (!cancelled.signal.aborted) fn()
      })
      return () => cancelled.abort()
    },
    every(ms, fn) {
      const stopped = new AbortController()
      void (async () => {
        let seen = wakes
        for (;;) {
          if (wakes === seen) await wait(ms, stopped.signal)
          if (stopped.signal.aborted) return
          seen = wakes
          const run = Promise.resolve()
            .then(fn)
            .catch((err: unknown) =>
              queueMicrotask(() => {
                throw err
              }),
            )
          if (signalled) await run
        }
      })()
      return () => stopped.abort()
    },
    wake() {
      wakes++
      for (const done of [...sleepers]) done()
    },
    waiting: () => (traced ? [...traced.values()] : []),
  }
}
