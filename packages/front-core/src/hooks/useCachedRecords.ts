import { useCallback, useEffect, useState } from "react"

/**
 * The read surface every `RecordStorage`-backed domain store already exposes
 * (`SavingsMoveStorage`, `BalanceStorage`, ...). `load()` must be memoized by
 * the store so repeat calls are free.
 */
export interface CachedRecordSource<T> {
  load(): Promise<void>
  /** False after a load that could not read storage, for a store that retries its loads. */
  isLoaded?(): boolean
  list(): T[]
  onListChanged(listener: (records: T[]) => void): () => void
}

/**
 * Cache-first read over a persisted record store: renders whatever the store
 * holds right now (the last known good state), kicks hydration from storage,
 * and re-renders as live writers (sync loops, chain trackers) overwrite
 * records. `hydrated` separates "still reading the cache" from "genuinely
 * empty", so screens can show a loading placeholder instead of a wrong empty
 * state. A failed load still flips `hydrated` — an empty list beats a
 * placeholder that never resolves — and sets `failed`, for a reader that must
 * not take that list as empty: a load that threw, or one that read nothing.
 * `failed` clears once a read lands, from `retry` or any other reader's load.
 */
export function useCachedRecords<T>(source: CachedRecordSource<T>): {
  records: T[]
  hydrated: boolean
  failed: boolean
  retry: () => void
} {
  const [records, setRecords] = useState<T[]>(() => source.list())
  const [hydrated, setHydrated] = useState(false)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    const unsubscribe = source.onListChanged((next) => {
      setRecords(next)
      if (source.isLoaded?.()) setFailed(false)
    })
    setRecords(source.list())
    // `failed` stands until this load answers: a list that could not be read must not pass for empty.
    void source.load().then(
      () => !cancelled && settle(source.isLoaded?.() === false),
      () => !cancelled && settle(true),
    )
    function settle(loadFailed: boolean) {
      setRecords(source.list())
      setFailed(loadFailed)
      setHydrated(true)
    }
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [source, attempt])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { records, hydrated, failed, retry }
}
