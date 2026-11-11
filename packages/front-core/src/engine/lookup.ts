import { liveStore } from "./liveStore"
import type { QueryEntry } from "./query"
import type { ReadonlyStore } from "./store"

/** What a lookup says about the key it holds: idle without one, waiting until its answer lands. */
export type Lookup<V> =
  | { status: "idle" }
  | { status: "waiting"; late: boolean }
  | { status: "answered"; value: V }
  | { status: "failed"; error: unknown }

/** A lookup's answer, with the key it answers. */
export type LookupState<K, V> = Lookup<V> & { key: K | undefined }

export interface LookupTiming {
  /** The key must hold this long before it is read. */
  delayMs: number
  /** With no answer by then, the lookup reads late until it lands. */
  lateMs?: number
}

export interface LookupStore<K, V> extends ReadonlyStore<LookupState<K, V>> {
  /** Reads the held key again now. */
  retry(): void
}

/**
 * The answer for a key a user is typing: its query entry, read once the key has held for
 * `delayMs`. A new key drops the wait and any answer still out, and reads "waiting" until the
 * entry's read for that key settles. A key typed back to the last one held reads at once. Works
 * only while subscribed.
 */
export function lookup<K, V>(
  key: ReadonlyStore<K | undefined>,
  entry: (key: K) => QueryEntry<V>,
  { delayMs, lateMs }: LookupTiming,
): LookupStore<K, V> {
  // The first key waits too, so it starts from none.
  const settled = debounced(key, delayMs, { from: undefined })
  let again = () => {}
  const store = liveStore<LookupState<K, V>>(idle(key.get()), {
    whileSubscribed(set) {
      let stop = () => {}
      let read = () => {}
      const wait = (k: K | undefined) => {
        stop()
        read = () => {}
        if (k === undefined) return set(idle(k))
        set({ key: k, status: "waiting", late: false })
        const reading = new AbortController()
        let answered = false
        const settle = (next: LookupState<K, V>) => {
          if (reading.signal.aborted) return
          answered = true
          set(next)
        }
        const late = lateMs
          ? setTimeout(() => answered || set({ key: k, status: "waiting", late: true }), lateMs)
          : undefined
        read = () => {
          read = () => {}
          void entry(k)
            .read(reading.signal)
            .then(
              (value) => settle({ key: k, status: "answered", value }),
              (error: unknown) => settle({ key: k, status: "failed", error }),
            )
        }
        stop = () => {
          reading.abort()
          clearTimeout(late)
        }
      }
      // A key typed back to the settled one gets no new settled key, so it reads at once.
      const readSettled = () => {
        if (Object.is(settled.get().key, typed)) read()
      }
      let typed = key.get()
      wait(typed)
      const offKey = key.subscribe(() => {
        if (Object.is(key.get(), typed)) return
        wait((typed = key.get()))
        readSettled()
      })
      const offSettled = settled.subscribe(readSettled)
      readSettled()
      again = () => {
        wait(typed)
        read()
      }
      return () => {
        offKey()
        offSettled()
        stop()
        again = () => {}
      }
    },
  })
  return { ...store, retry: () => again() }
}

/** A debounced key, and the one it took over from. */
export interface DebouncedKey<K> {
  key: K
  before?: K
}

/**
 * `key` once it has held for `ms`, beside the key it took over from: what a quote or a lookup reads
 * while a user types, so only the input they settle on is read. Each change restarts the wait, and
 * a key typed back to the held one changes nothing. A subscribe holds the current key at once, or
 * `start.from` until the current key has held. Works only while subscribed.
 */
export function debounced<K>(
  key: ReadonlyStore<K>,
  ms: number,
  start?: { from: K },
): ReadonlyStore<DebouncedKey<K>> {
  const first = (): DebouncedKey<K> => ({ key: start ? start.from : key.get() })
  return liveStore<DebouncedKey<K>>(first(), {
    whileSubscribed(set) {
      let current = first()
      set(current)
      let timer: ReturnType<typeof setTimeout> | undefined
      const hold = () => {
        clearTimeout(timer)
        timer = setTimeout(() => {
          if (Object.is(key.get(), current.key)) return
          set((current = { key: key.get(), before: current.key }))
        }, ms)
      }
      if (start) hold()
      const off = key.subscribe(hold)
      return () => {
        off()
        clearTimeout(timer)
      }
    },
  })
}

function idle<K, V>(key: K | undefined): LookupState<K, V> {
  return key === undefined ? { key, status: "idle" } : { key, status: "waiting", late: false }
}
