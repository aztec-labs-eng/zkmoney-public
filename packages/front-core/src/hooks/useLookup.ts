import { useEffect, useMemo, useState } from "react"
import {
  debounced,
  lookup,
  type DebouncedKey,
  type Lookup,
  type LookupTiming,
} from "../engine/lookup"
import type { QueryEntry } from "../engine/query"
import { memoryStore } from "../engine/store"
import { useStore } from "./useStore"

/**
 * The lookup of a key the view holds, such as a typed address: `entry` read once the key settles.
 * A new key reads "waiting" from its first render until its own answer lands.
 */
export function useLookup<K, V>(
  key: K | undefined,
  entry: (key: K) => QueryEntry<V>,
  timing: LookupTiming,
): Lookup<V> & { retry(): void } {
  const [typed] = useState(() => memoryStore(key))
  const { delayMs, lateMs } = timing
  // A new query reads the typed key again.
  const answer = useMemo(
    () => lookup(typed.readonly, entry, { delayMs, lateMs }),
    [typed, entry, delayMs, lateMs],
  )
  useEffect(() => typed.set(key), [typed, key])
  const state = useStore(answer)
  const current: Lookup<V> = Object.is(state.key, key)
    ? state
    : key === undefined
    ? { status: "idle" }
    : { status: "waiting", late: false }
  return { ...current, retry: answer.retry }
}

/** `key` once the view has held it for `ms`, beside the key it took over from. Pass a stable key. */
export function useDebouncedKey<K>(key: K, ms: number): DebouncedKey<K> {
  const [typed] = useState(() => memoryStore(key))
  const keys = useMemo(() => debounced(typed.readonly, ms), [typed, ms])
  useEffect(() => typed.set(key), [typed, key])
  return useStore(keys)
}
