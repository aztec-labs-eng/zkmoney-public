import type { Pace } from "@obsidion/core/cadence"
import { logger } from "../utils/logger"
import { WalletError } from "./errors"
import type { Backoff } from "./service"
import { subscribedStore } from "./liveStore"
import { memoryStore, type ReadonlyStore } from "./store"

/**
 * A remote value per key, read once and cached. Subscribing to an entry starts its read when it is
 * pending or stale, and polls it while subscribed. `read()` returns a fresh value,
 * and every reader in the meantime shares one load. A value stays on screen, marked refreshing,
 * while it is read again or the next subscribe would read it again. A failed re-read keeps it and
 * sets `error`, which the next good read clears.
 */

export type QueryState<T> =
  | { status: "pending" }
  /**
   * `refreshing`: a read is out, or the next subscribe reads again. `error`: the last re-read
   * failed, so `value` is from an earlier read.
   */
  | { status: "ready"; value: T; refreshing: boolean; error?: unknown }
  /** `retryAt`: a backoff retry is scheduled. */
  | { status: "failed"; error: unknown; retryAt?: number }

export interface QueryEntry<T> extends ReadonlyStore<QueryState<T>> {
  readonly name: string
  /** A fresh value: the cached one if not stale, else that of the load in flight or a new one. */
  read(signal?: AbortSignal): Promise<T>
  /** Reads again now, and a `read()` until it lands waits for it. A load in flight is dropped. */
  refresh(): void
}

export interface QuerySpec<A extends unknown[], T> {
  /** The entry's key arguments, then the signal a `refresh()` aborts. */
  load: (...args: [...A, AbortSignal]) => Promise<T>
  /** When a ready value must be read again: after `ms`, or when the rule says so. Never by default. */
  stale?: number | ((value: T, ageMs: number) => boolean)
  /** Reads again every `ms` while subscribed and the page is visible. */
  poll?: number
  /** A value that can no longer change: the entry stops polling and is never stale again. */
  final?: (value: T) => boolean
  /**
   * A backoff retries a failed load while the entry is subscribed. "onRead" (default) loads it again
   * on the next read or subscribe.
   */
  retry?: Backoff | "onRead"
}

export interface QueryDeps {
  /** The page's: every poll waits on it, so a test world wakes it. */
  pace: Pick<Pace, "after" | "mark">
  /** Polls pause while false. */
  visible: ReadonlyStore<boolean>
  /** The page's wall time, ms epoch: staleness and backoffs count from it. */
  now: () => number
}

export type Query<A extends unknown[], T> = (...args: A) => QueryEntry<T>

/** The state of a read no view starts: for a view with nothing to read yet. */
export const UNREAD: ReadonlyStore<QueryState<never>> = memoryStore<QueryState<never>>({
  status: "pending",
}).readonly

const HEX = /^0x[0-9a-f]*$/i

/**
 * The entry key of `args`, equal for equal values: a bigint by its value, a hex string (an
 * address) in lowercase, an object with a `toString` of its own (an AztecAddress, an Fr) by that
 * string, and a plain object or an array by its fields.
 */
export function queryKey(args: readonly unknown[]): string {
  const part = (v: unknown): string => {
    if (typeof v === "bigint") return `${v}n`
    if (typeof v === "string") return JSON.stringify(HEX.test(v) ? v.toLowerCase() : v)
    if (typeof v === "number" || typeof v === "boolean" || v === undefined) return String(v)
    if (v === null) return "null"
    if (Array.isArray(v)) return `[${v.map(part).join(",")}]`
    if (typeof v === "object") {
      if (v.toString !== Object.prototype.toString) return part(String(v))
      const fields = Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))
      return `{${fields.map(([k, field]) => `${JSON.stringify(k)}:${part(field)}`).join(",")}}`
    }
    throw new WalletError("invariant", `query key: a ${typeof v} is no key`)
  }
  return part(args)
}

export type QueryFactory = ReturnType<typeof queries>

/** The page's query constructor, over its pace, visibility and clock. */
export function queries({ pace, visible, now }: QueryDeps) {
  return function query<A extends unknown[], T>(name: string, spec: QuerySpec<A, T>): Query<A, T> {
    const entries = new Map<string, QueryEntry<T>>()
    const backoff = spec.retry === "onRead" ? undefined : spec.retry
    const rule = spec.stale
    const stale =
      typeof rule === "number" ? (_: T, age: number) => age >= rule : rule ?? (() => false)
    return (...args) => {
      const key = queryKey(args)
      let entry = entries.get(key)
      if (!entry)
        entries.set(key, (entry = createEntry(args.length ? `${name}:${key}` : name, args)))
      return entry
    }

    function createEntry(entryName: string, args: A): QueryEntry<T> {
      // The read a subscribe starts reaches the first subscriber, which is listening by then.
      const state = subscribedStore<QueryState<T>>({ status: "pending" }, () => {
        subscribed = true
        onSubscribed()
        return onUnsubscribed
      })
      /** Readers waiting on the load in flight, or on the one a refresh puts in its place. */
      const waiters = new Set<(ok: boolean, result: unknown) => void>()
      let run: AbortController | undefined
      let loadedAt = 0
      let latched = false
      /** A refresh asked for a new value: the cached one is not fresh until a load lands. */
      let refreshed = false
      let subscribed = false
      let failures = 0
      /**
       * When the retry a failed load is owed falls due: after its backoff, or at once for "onRead".
       * Only a backoff arms a timer, and only while subscribed.
       */
      let dueAt: number | undefined
      let retryTimer: ReturnType<typeof setTimeout> | undefined
      let cancelPoll: (() => void) | undefined
      let offVisible: (() => void) | undefined

      const fresh = (s: QueryState<T>) =>
        s.status === "ready" &&
        !refreshed &&
        (latched || (dueAt === undefined && !stale(s.value, now() - loadedAt)))

      /** A backoff holds the retry a failed load is owed. */
      const held = () => dueAt !== undefined && dueAt > now()
      /** A subscribe now would load `s` again. */
      const due = (s: QueryState<T>) => !run && !held() && !fresh(s)
      /** `s` marked refreshing, kept so equal reads get the same object. */
      let marked: { from: QueryState<T>; to: QueryState<T> } | undefined

      const stopPoll = () => {
        cancelPoll?.()
        cancelPoll = undefined
      }
      const disarm = () => {
        clearTimeout(retryTimer)
        retryTimer = undefined
        stopPoll()
      }

      /** The backoff retry due at `dueAt`, while subscribed; shown on a failed entry. */
      const arm = () => {
        if (dueAt === undefined || !subscribed || run) return
        retryTimer = setTimeout(load, Math.max(0, dueAt - now()))
        const s = state.get()
        if (s.status === "failed") state.set({ status: "failed", error: s.error, retryAt: dueAt })
      }

      /** The next poll, `since` the pace mark the last load began at. */
      const schedulePoll = (since: number) => {
        if (!spec.poll || !subscribed || latched || run || !visible.get()) return
        stopPoll()
        cancelPoll = pace.after(spec.poll, load, since)
      }

      /** This load's readers, taken before its result notifies, so a reader added then waits for its own. */
      const taken = () => {
        const settling = [...waiters]
        waiters.clear()
        return (ok: boolean, result: unknown) => {
          for (const waiter of settling) waiter(ok, result)
        }
      }

      function load() {
        run?.abort()
        disarm()
        const current = (run = new AbortController())
        const since = pace.mark()
        const before = state.get()
        if (before.status === "ready" && !before.refreshing)
          state.set({ ...before, refreshing: true })
        new Promise<T>((resolve) => resolve(spec.load(...args, current.signal))).then(
          (value) => {
            if (current.signal.aborted) return
            run = undefined
            refreshed = false
            failures = 0
            dueAt = undefined
            loadedAt = now()
            if (spec.final?.(value)) latched = true
            const settle = taken()
            state.set({ status: "ready", value, refreshing: false })
            settle(true, value)
            schedulePoll(since)
          },
          (error: unknown) => {
            if (current.signal.aborted) return
            run = undefined
            refreshed = false
            logger.warn(`[query] ${entryName} failed:`, error)
            const settle = taken()
            if (!backoff) dueAt = now()
            else {
              failures++
              dueAt = now() + Math.min(backoff.baseMs * 2 ** (failures - 1), backoff.maxMs)
            }
            const held = state.get()
            state.set(
              held.status === "ready"
                ? { ...held, refreshing: false, error }
                : { status: "failed", error },
            )
            settle(false, error)
            if (backoff) arm()
            else schedulePoll(since)
          },
        )
      }

      const onSubscribed = () => {
        if (spec.poll)
          offVisible = visible.subscribe(() => {
            if (!visible.get()) return stopPoll()
            if (!latched && !run) load()
          })
        if (due(state.get())) return load()
        if (run) return
        // A retry owed outlives the subscription, whether the entry failed or kept its value.
        if (held()) return arm()
        if (spec.poll && !latched && visible.get())
          cancelPoll = pace.after(Math.max(0, spec.poll - (now() - loadedAt)), load)
      }

      const onUnsubscribed = () => {
        subscribed = false
        offVisible?.()
        offVisible = undefined
        disarm()
        const s = state.get()
        if (s.status === "failed" && s.retryAt !== undefined)
          state.set({ status: "failed", error: s.error })
      }

      return {
        ...state.readonly,
        /** A value a subscribe reads again shows as refreshing from the first `get()`. */
        get() {
          const s = state.get()
          if (s.status !== "ready" || s.refreshing || subscribed || !due(s)) return s
          if (marked?.from !== s) marked = { from: s, to: { ...s, refreshing: true } }
          return marked.to
        },
        name: entryName,
        read(signal) {
          if (signal?.aborted)
            return Promise.reject(new WalletError("aborted", `${entryName} aborted`))
          const s = state.get()
          if (fresh(s) && s.status === "ready") return Promise.resolve(s.value)
          return new Promise<T>((resolve, reject) => {
            const aborted = () => {
              waiters.delete(waiter)
              reject(new WalletError("aborted", `${entryName} aborted`))
            }
            const waiter = (ok: boolean, result: unknown) => {
              signal?.removeEventListener("abort", aborted)
              if (ok) resolve(result as T)
              else reject(result)
            }
            waiters.add(waiter)
            signal?.addEventListener("abort", aborted)
            if (!run) load()
          })
        },
        refresh() {
          refreshed = true
          load()
        },
      }
    }
  }
}
