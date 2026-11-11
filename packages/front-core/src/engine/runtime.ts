import type { Pace } from "@obsidion/core/cadence"
import { logger } from "../utils/logger"
import type { Database } from "./database"
import { bestEffort, WalletError } from "./errors"
import type { After, Milestone, Milestones } from "./milestones"
import type { Backoff, Input, Service } from "./service"
import type { ReadonlyStore } from "./store"

/**
 * Background work as declared tasks. A task waits for its milestones, the bounds counted from its
 * needs first being ready, and runs only while every need is ready and `when` holds, one run at a
 * time: once, or every `every` ms or the `nextMs` a clean run returns, and at once when woken. A
 * need leaving ready or replaced, or `when` turning false, aborts the run in flight; ready again,
 * the task runs, after any backoff. A change to a store a once task runs `on` lets the run in
 * flight finish; a clean run then runs again on the new value. A failed run backs off, and the
 * backoff outlives a restart; with no backoff, it waits for the next change. Hiding the page aborts
 * a pausing task's run in flight; a task with a hidden pace keeps running at it, and a once task
 * runs on as if shown. Showing the page runs either at once, ahead of any backoff. A wake settles
 * at once when its run is aborted, or when it finds its task hidden, a need not ready or `when`
 * false.
 */

/**
 * A service. A store that gates a task is its `when`, and a store whose value it
 * reads is `on`. A query entry is none: a run reads it with `read(signal)`, so no task keeps its
 * poll running.
 */
export type Need = Service<unknown>
export type Needs = Record<string, Need>

/** Stores a task runs on: they never gate it, and a change runs it again. */
export type Ons = Record<string, ReadonlyStore<unknown>>

export type Ready<N extends Needs> = { [K in keyof N]: N[K] extends Input<infer V> ? V : never }
export type OnValues<O extends Ons> = {
  [K in keyof O]: O[K] extends ReadonlyStore<infer V> ? V : never
}

export interface RunBase {
  /**
   * Aborted on stop, on a need leaving ready, on `when` turning false, or on hide for a pausing
   * task. Every wait in a run ends on it: `within`.
   */
  signal: AbortSignal
  /** Woken, started, shown or given its needs; not run by the cadence or a backoff retry. */
  woken: boolean
  wake(task: Task): Promise<void>
  reached(milestone: Milestone): boolean
}

export type RunCtx<N extends Needs, O extends Ons = Record<never, never>> = Ready<N> &
  OnValues<O> &
  RunBase

interface SpecBase<N extends Needs> {
  /** Runs only while every one is ready, and receives their values; never starts them. */
  needs: N
  /** Runs only while true; false aborts the run in flight and pauses the task. */
  when?: ReadonlyStore<boolean>
  after?: After
  /** Kept in the runtime's database. */
  backoff?: Backoff
}

/** One clean run per runtime, and one more on each change to a store it runs `on`. */
export interface OnceSpec<N extends Needs, O extends Ons> extends SpecBase<N> {
  every: "once"
  /** The run receives their values as they are at its start; a change runs the task again. */
  on?: O
  whenHidden?: never
  run(ctx: RunCtx<N, O>): Promise<void>
}

/**
 * A run every `every` ms. `O` stays empty: it gives both forms one `run` context, so `run`'s
 * parameter is inferred.
 */
export interface PeriodicSpec<N extends Needs, O extends Ons> extends SpecBase<N> {
  /**
   * Ms between runs, or a store of them. A new value moves the wait in place, counted from the
   * last run's end, and never aborts a run in flight.
   */
  every: number | ReadonlyStore<number>
  on?: never
  /**
   * "pause" (default): hiding aborts the run, and showing runs it again. A number: ms between runs
   * while hidden, or a returned `nextMs` if longer.
   */
  whenHidden?: "pause" | number
  /** `nextMs`: the delay to the next run in place of `every`. A failed run backs off instead. */
  run(ctx: RunCtx<N, O>): Promise<void | { nextMs: number }>
}

export type TaskSpec<N extends Needs, O extends Ons = Record<never, never>> =
  | OnceSpec<N, O>
  | PeriodicSpec<N, O>

/** A task's handle: what a runtime runs and wakes. */
export interface Task {
  readonly name: string
}

// eslint-disable-next-line no-restricted-syntax -- debt
const specs = new WeakMap<Task, TaskSpec<Needs, Ons>>()

export function task<const N extends Needs, const O extends Ons = Record<never, never>>(
  name: string,
  spec: TaskSpec<N, O>,
): Task {
  const handle: Task = { name }
  specs.set(handle, spec as unknown as TaskSpec<Needs, Ons>)
  return handle
}

export interface RuntimeDeps {
  /** Where backoff is kept. */
  db: Database
  milestones: Pick<Milestones, "after" | "reached">
  visible: ReadonlyStore<boolean>
  /** The page's: a task's cadence waits on it, as every poll does. */
  pace: Pick<Pace, "after" | "mark">
  /** The page's wall time, ms epoch: backoffs and cadence waits count from it. */
  now: () => number
}

export interface Runtime {
  /** Runs the task now, or after the run in flight; settles once a run begun after it ends. */
  wake(task: Task): Promise<void>
  stop(): void
}

interface Slot {
  task: Task
  spec: TaskSpec<Needs, Ons>
  /** Its milestones were reached. */
  gated: boolean
  held: boolean
  /** The need values the last run took. */
  values?: unknown[]
  /** The `on` values the last run took. */
  ons?: unknown[]
  /** A "once" task ran clean. */
  done: boolean
  failures: number
  retryAt?: number
  run?: AbortController
  rerun: boolean
  /** An `on` store changed during the run in flight. */
  onChanged: boolean
  /** The next run is not the cadence's. */
  woken: boolean
  /** Cancels the next run's wait: a cadence's poll wait, or a backoff's timer. */
  cancel?: () => void
  /** The wait in place is `every`'s store value: when the last run ended, and its pace mark. */
  follows?: { endedAt: number; since: number }
  waiters: (() => void)[]
}

const backoffKey = (name: string) => `runtime/backoff/${name}`

const settleWaiters = (slot: Slot) => {
  for (const resolve of slot.waiters.splice(0)) resolve()
}

/** Each need's value, or undefined while one is not ready. */
const needValues = ({ spec }: Slot): unknown[] | undefined => {
  const states = Object.values(spec.needs).map((r) => r.get())
  return states.every((s) => s.status === "ready")
    ? states.map((s) => (s as { value: unknown }).value)
    : undefined
}

/** `when` holds, or the task has none. */
const allowed = ({ spec }: Slot) => spec.when?.get() ?? true

/** What a task runs only while ready: its needs and its `when`. */
const gates = ({ spec }: Slot): ReadonlyStore<unknown>[] => [
  ...Object.values(spec.needs),
  ...(spec.when ? [spec.when] : []),
]

/** Each `on` store's value. */
const onValues = ({ spec }: Slot): unknown[] => Object.values(spec.on ?? {}).map((s) => s.get())

const sameValues = (a: unknown[], b: unknown[]) => a.every((v, i) => Object.is(v, b[i]))

/** A periodic task's ms between runs. */
const interval = (every: number | ReadonlyStore<number>) =>
  typeof every === "number" ? every : every.get()

/** Keeps running while hidden, at its own pace. */
const paced = ({ spec }: Slot) => spec.every !== "once" && typeof spec.whenHidden === "number"

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
    const aborted = () => end(() => reject(new WalletError("aborted", `${label} aborted`)))
    const timer =
      ms === undefined
        ? undefined
        : setTimeout(
            () => end(() => reject(new WalletError("timeout", `${label} timed out after ${ms}ms`))),
            ms,
          )
    // Observed even when abandoned, so its late rejection is never unhandled.
    work.then(
      (value) => end(() => resolve(value)),
      (err: unknown) => end(() => reject(err)),
    )
    if (signal?.aborted) return aborted()
    signal?.addEventListener("abort", aborted)
  })
}

export function startRuntime(tasks: readonly Task[], deps: RuntimeDeps): Runtime {
  let stopped = false
  const ended = new AbortController()
  const slots = new Map<Task, Slot>(
    tasks.map((task) => {
      const spec = specs.get(task)
      if (!spec) throw new WalletError("invariant", `runtime: ${task.name} is not a task`)
      const flags = {
        gated: false,
        held: false,
        done: false,
        rerun: false,
        onChanged: false,
        woken: true,
      }
      return [task, { task, spec, ...flags, failures: 0, waiters: [] }]
    }),
  )
  let shown = deps.visible.get()

  const holds = (slot: Slot) =>
    allowed(slot) &&
    needValues(slot) !== undefined &&
    (slot.spec.every === "once" || paced(slot) || shown)

  /**
   * The next run after `ms`. A cadence is a poll on outside state: it waits on `deps.pace`, so the
   * environment may shorten it or run it on a change. A backoff is not a poll and keeps its own
   * timer. A cadence given the {@link Pace.mark} its run began at also runs at once on a wake that
   * came during the run, which no wait was there to hear.
   */
  const schedule = (slot: Slot, ms: number | undefined, cadence = false, since?: number) => {
    slot.cancel?.()
    slot.cancel = slot.follows = undefined
    if (ms === undefined) return
    if (cadence) {
      slot.cancel = deps.pace.after(ms, () => go(slot, false), since)
      return
    }
    const timer = setTimeout(() => go(slot, false), ms)
    slot.cancel = () => clearTimeout(timer)
  }

  /** The delay before the next run, if any, and whether it is the cadence's. */
  const settle = (
    slot: Slot,
    failed: boolean,
    next: number | undefined,
  ): [number | undefined, boolean] => {
    const { spec, task } = slot
    if (failed && spec.backoff) {
      slot.failures++
      const delay = Math.min(spec.backoff.baseMs * 2 ** (slot.failures - 1), spec.backoff.maxMs)
      slot.retryAt = deps.now() + delay
      const saved = `${slot.failures} ${slot.retryAt}`
      void bestEffort(
        "unknown",
        deps.db.write(async (w) => w.put(backoffKey(task.name), saved)),
      )
      return [delay, false]
    }
    if (slot.failures > 0)
      void bestEffort(
        "unknown",
        deps.db.write(async (w) => w.remove(backoffKey(task.name))),
      )
    slot.failures = 0
    slot.retryAt = undefined
    if (spec.every === "once") {
      slot.done = !failed
      return [undefined, false]
    }
    const delay =
      shown || typeof spec.whenHidden !== "number"
        ? next ?? interval(spec.every)
        : Math.max(next ?? 0, spec.whenHidden)
    // A failed run waits on a timer: what it waits for is not outside state a change would signal.
    return [delay, !failed]
  }

  const execute = async (slot: Slot) => {
    const { spec, task } = slot
    const values = needValues(slot)
    if (!values) return
    slot.values = values
    const ons = (slot.ons = onValues(slot))
    schedule(slot, undefined)
    const began = deps.pace.mark()
    const run = (slot.run = new AbortController())
    const waiters = slot.waiters.splice(0)
    const release = () => {
      for (const resolve of waiters.splice(0)) resolve()
    }
    run.signal.addEventListener("abort", release)
    const ready = {
      ...Object.fromEntries(Object.keys(spec.needs).map((key, i) => [key, values[i]])),
      ...Object.fromEntries(Object.keys(spec.on ?? {}).map((key, i) => [key, ons[i]])),
    }
    let failed = false
    let next: number | undefined
    try {
      const result = await spec.run({
        ...ready,
        signal: run.signal,
        woken: slot.woken,
        wake,
        reached: (m) => deps.milestones.reached(m),
      })
      next = result?.nextMs
    } catch (e) {
      failed = !run.signal.aborted
      if (failed) logger.warn(`[runtime] ${task.name} failed:`, e)
    }
    slot.run = undefined
    release()
    if (stopped) return
    const [delay, cadence] = run.signal.aborted ? [undefined, false] : settle(slot, failed, next)
    // An `on` change during a failed run waits for the backoff, or for the next change.
    const again = slot.rerun || (slot.onChanged && !failed)
    slot.rerun = slot.onChanged = false
    if (!holds(slot)) return
    if (again) return go(slot)
    schedule(slot, delay, cadence, began)
    if (cadence && next === undefined && shown && typeof spec.every === "object")
      slot.follows = { endedAt: deps.now(), since: began }
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

  /** Runs now, or once the backoff in place ends. */
  const resume = (slot: Slot) => {
    const wait = (slot.retryAt ?? 0) - deps.now()
    if (wait > 0) schedule(slot, wait)
    else go(slot)
  }

  const pause = (slot: Slot) => {
    schedule(slot, undefined)
    slot.run?.abort()
    settleWaiters(slot)
  }

  /** Settles once every need is ready, or on stop. */
  const needsReady = (slot: Slot) =>
    new Promise<void>((resolve) => {
      let offs: (() => void)[] = []
      const check = () => {
        if (!stopped && !(allowed(slot) && needValues(slot))) return
        for (const off of offs) off()
        ended.signal.removeEventListener("abort", check)
        resolve()
      }
      offs = gates(slot).map((input) => input.subscribe(check))
      ended.signal.addEventListener("abort", check)
      check()
    })

  const gate = async (slot: Slot) => {
    const { spec, task } = slot
    await needsReady(slot)
    // Always yields, so a wake issued beside the start joins the first run.
    if (!(await (spec.after ? deps.milestones.after(spec.after, ended.signal) : true))) return
    // Read through the writer, so a save an earlier runtime queued lands first. A backoff that
    // cannot be read is none: the run goes ahead.
    const saved =
      !stopped &&
      (await bestEffort(
        "unknown",
        deps.db.write((w) => w.get(backoffKey(task.name))),
      ))
    if (stopped) return
    slot.gated = true
    slot.held = holds(slot)
    if (!slot.held) settleWaiters(slot)
    const [failures, retryAt] = (saved || "").split(" ")
    if (Number(failures) > 0) {
      slot.failures = Number(failures)
      slot.retryAt = Number(retryAt)
    }
    resume(slot)
  }

  const onNeeds = (slot: Slot) => {
    if (stopped || !slot.gated) return
    const held = holds(slot)
    const values = held ? needValues(slot) : undefined
    const replaced = !!values && !!slot.values && !sameValues(values, slot.values)
    if (held === slot.held && !replaced) return
    slot.held = held
    if (!held) return pause(slot)
    if (replaced) {
      slot.values = undefined
      slot.done = false
      slot.run?.abort()
    } else if (slot.ons && !sameValues(onValues(slot), slot.ons)) slot.done = false
    if (!slot.done) resume(slot)
  }

  /** An `on` store changed: the task runs again, after the run in flight. */
  const onStore = (slot: Slot) => {
    if (stopped || !slot.gated || !slot.held) return
    if (slot.run && !slot.run.signal.aborted) {
      slot.onChanged = true
      return
    }
    if (slot.ons && sameValues(onValues(slot), slot.ons)) return
    slot.done = false
    resume(slot)
  }

  /** `every`'s store changed: the wait in place counts the new value from the last run's end. */
  const onInterval = (slot: Slot) => {
    const { follows, spec } = slot
    if (stopped || !follows || !shown || spec.every === "once") return
    const left = interval(spec.every) - (deps.now() - follows.endedAt)
    schedule(slot, Math.max(0, left), true, follows.since)
    slot.follows = follows
  }

  const onVisibility = () => {
    const now = deps.visible.get()
    if (now === shown) return
    shown = now
    for (const slot of slots.values()) {
      if (!slot.gated) continue
      const held = holds(slot)
      if (held !== slot.held) {
        slot.held = held
        if (held) go(slot)
        else pause(slot)
      } else if (held && shown && paced(slot) && !slot.run) go(slot)
    }
  }

  const offs = [deps.visible.subscribe(onVisibility)]
  for (const slot of slots.values()) {
    for (const input of gates(slot)) offs.push(input.subscribe(() => onNeeds(slot)))
    for (const store of Object.values(slot.spec.on ?? {}))
      offs.push(store.subscribe(() => onStore(slot)))
    const { every } = slot.spec
    if (typeof every === "object") offs.push(every.subscribe(() => onInterval(slot)))
    void gate(slot)
  }

  function wake(task: Task): Promise<void> {
    const slot = slots.get(task)
    if (!slot || stopped) return Promise.resolve()
    // Hidden or missing a need: the show or the need runs it.
    if (!holds(slot)) return Promise.resolve()
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
      ended.abort()
      for (const off of offs) off()
      for (const slot of slots.values()) pause(slot)
    },
  }
}
