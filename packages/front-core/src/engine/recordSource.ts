import { memoryStore, type ReadonlyStore } from "./store"

/** The read surface of a `RecordStorage`-backed store not yet moved onto a persistent store. */
export interface RecordSource<T> {
  load(): Promise<void>
  list(): T[]
  onListChanged(listener: (records: T[]) => void): () => void
}

export interface Loaded<T> {
  records: readonly T[]
  /** The first load settled, so an empty list is known to be empty. A failed load counts. */
  hydrated: boolean
}

/** A record source as a store: it mirrors the list from now on and starts the source's load. */
export function legacyRecords<T>(source: RecordSource<T>): ReadonlyStore<Loaded<T>> {
  const store = memoryStore<Loaded<T>>({ records: source.list(), hydrated: false })
  source.onListChanged((records) => store.update((s) => ({ ...s, records })))
  const hydrate = () => store.set({ records: source.list(), hydrated: true })
  void source.load().then(hydrate, hydrate)
  return store.readonly
}
