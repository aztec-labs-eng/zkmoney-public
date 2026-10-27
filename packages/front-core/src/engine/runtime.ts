import type { BootReader } from "../core/services/transactions/bootPriority"
import { logger } from "../utils/logger"
import type { KvStore } from "./kv"
import type { ReadonlyStore } from "./store"

/**
 * Background work as declared tasks. A task waits for its boot stage, then runs one run at a
 * time: once, or every `cadence` ms while the page is visible, and at once when woken. A failed
 * run backs off, and the backoff outlives a restart. Hiding the page aborts a periodic task's run
 * in flight; showing it runs the task at once, ahead of any backoff. A wake settles at once when
 * its run is aborted, or when it finds its task hidden.
 */

export interface TaskDef {
  id: string
  stage?: BootReader
  /** Ms between runs while visible; paused while hidden. */
  cadence: number | "once"
  backoff?: { baseMs: number; maxMs: number }
  run(ctx: TaskCtx): Promise<void>
}

export interface TaskCtx {
  /** Aborted on stop, or on hide for a periodic task. Every wait in a run ends on it: `within`. */
  signal: AbortSignal
  /** Woken, started or shown, not run by the cadence or a backoff retry. */
  woken: boolean
  wake(id: string): Promise<void>
}

export interface RuntimeDeps {
  /** Where backoff is kept. */
  kv: KvStore
  whenReady(stage: BootReader): Promise<void>
  /** Absent: always visible. */
  visible?: ReadonlyStore<boolean>
}

export interface Runtime {
  /** Runs the task now, or after the run in flight; settles once a run begun after it ends. */
  wake(id: string): Promise<void>
  stop(): void
}

interface Slot {
  def: TaskDef
  /** The stage was reached. */
  gated: boolean
  held: boolean
  failures: number
  run?: AbortController
  rerun: boolean
  /** The next run is not the cadence's. */
  woken: boolean
  timer?: ReturnType<typeof setTimeout>
  waiters: (() => void)[]
}

const backoffKey = (id: string) => `runtime/backoff/${id}`

const settleWaiters = (slot: Slot) => {
  for (const resolve of slot.waiters.splice(0)) resolve()
}

/**
 * A wait inside a run: settles with `work`, or rejects once `ms` passes or `signal` aborts, so an
 * aborted run lets go of everything at once. `work` itself runs on.
 */
export function within<T>(
  work: Promise<T>,
  label: string,
  { ms, signal }: { ms?: number; signal?: AbortSignal },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const end = (settle: () => void) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", aborted)
      settle()
    }
    const aborted = () => end(() => reject(new Error(`${label} aborted`)))
    const timer =
      ms === undefined
        ? undefined
        : setTimeout(() => end(() => reject(new Error(`${label} timed out after ${ms}ms`))), ms)
    // Observed even when abandoned, so its late rejection is never unhandled.
    work.then(
      (value) => end(() => resolve(value)),
      (err: unknown) => end(() => reject(err)),
    )
    if (signal?.aborted) return aborted()
    signal?.addEventListener("abort", aborted)
  })
}

export function startRuntime(tasks: readonly TaskDef[], deps: RuntimeDeps): Runtime {
  let stopped = false
  const slots = new Map<string, Slot>(
    tasks.map((def) => {
      const flags = { gated: false, held: false, rerun: false, woken: true }
      return [def.id, { def, ...flags, failures: 0, waiters: [] }]
    }),
  )

  const holds = ({ def }: Slot) => def.cadence === "once" || (deps.visible?.get() ?? true)

  const schedule = (slot: Slot, ms: number | undefined) => {
    clearTimeout(slot.timer)
    slot.timer = ms === undefined ? undefined : setTimeout(() => go(slot, false), ms)
  }

  /** The delay before the next run, if any. */
  const settle = (slot: Slot, failed: boolean) => {
    const { def } = slot
    if (failed && def.backoff) {
      slot.failures++
      const delay = Math.min(def.backoff.baseMs * 2 ** (slot.failures - 1), def.backoff.maxMs)
      deps.kv.setItem(backoffKey(def.id), `${slot.failures} ${Date.now() + delay}`)
      return delay
    }
    if (slot.failures > 0) deps.kv.removeItem(backoffKey(def.id))
    slot.failures = 0
    return def.cadence === "once" ? undefined : def.cadence
  }

  const execute = async (slot: Slot) => {
    const { def } = slot
    schedule(slot, undefined)
    const run = (slot.run = new AbortController())
    const waiters = slot.waiters.splice(0)
    const release = () => {
      for (const resolve of waiters.splice(0)) resolve()
    }
    run.signal.addEventListener("abort", release)
    let failed = false
    try {
      await def.run({ signal: run.signal, woken: slot.woken, wake })
    } catch (e) {
      failed = !run.signal.aborted
      if (failed) logger.warn(`[runtime] ${def.id} failed:`, e)
    }
    slot.run = undefined
    release()
    if (stopped) return
    const delay = run.signal.aborted ? undefined : settle(slot, failed)
    const again = slot.rerun
    slot.rerun = false
    if (!holds(slot)) return
    if (again) return go(slot)
    schedule(slot, delay)
  }

  const go = (slot: Slot, woken = true) => {
    if (stopped || !slot.gated) return
    if (slot.run) {
      slot.rerun = true
      return
    }
    slot.woken = woken
    if (holds(slot)) void execute(slot)
  }

  const gate = async (slot: Slot) => {
    const { def } = slot
    // Always yields, so a wake issued beside the start joins the first run.
    await (def.stage && deps.whenReady(def.stage))
    if (stopped) return
    slot.gated = true
    slot.held = holds(slot)
    if (!slot.held) settleWaiters(slot)
    const [failures, nextAttemptAt] = (deps.kv.getItem(backoffKey(def.id)) ?? "").split(" ")
    if (Number(failures) > 0) slot.failures = Number(failures)
    const wait = Number(nextAttemptAt) - Date.now()
    if (wait > 0) schedule(slot, wait)
    else go(slot)
  }

  const onVisibility = () => {
    for (const slot of slots.values()) {
      const held = holds(slot)
      if (!slot.gated || held === slot.held) continue
      slot.held = held
      schedule(slot, undefined)
      if (held) go(slot)
      else {
        slot.run?.abort()
        settleWaiters(slot)
      }
    }
  }
  const unsubscribe = deps.visible?.subscribe(onVisibility)

  for (const slot of slots.values()) void gate(slot)

  function wake(id: string): Promise<void> {
    const slot = slots.get(id)
    if (!slot || stopped) return Promise.resolve()
    // Hidden: the show runs it.
    if (slot.gated && !holds(slot)) return Promise.resolve()
    const ran = new Promise<void>((resolve) => slot.waiters.push(resolve))
    schedule(slot, undefined)
    go(slot)
    return ran
  }

  return {
    wake,
    stop() {
      if (stopped) return
      stopped = true
      unsubscribe?.()
      for (const slot of slots.values()) {
        schedule(slot, undefined)
        slot.run?.abort()
        settleWaiters(slot)
      }
    },
  }
}
