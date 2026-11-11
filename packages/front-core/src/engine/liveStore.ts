import { memoryStore, type ReadonlyStore, type Store } from "./store"

/**
 * A store that holds work only while something subscribes. `whileSubscribed` runs when the first
 * subscriber arrives, after it listens, and the teardown it returns runs when the last one leaves.
 * Only `whileSubscribed` writes it, so each store has one writer.
 */
export function liveStore<T>(
  initial: T,
  { whileSubscribed }: { whileSubscribed: (set: (next: T) => void) => () => void },
): ReadonlyStore<T> {
  return subscribedStore(initial, whileSubscribed).readonly
}

/**
 * The engine's writable form, for a store its owner also writes while nothing subscribes (a query
 * entry that `read()` loads). Not exported from the engine index.
 */
export function subscribedStore<T>(
  initial: T,
  whileSubscribed: (set: (next: T) => void) => () => void,
): Store<T> {
  const store = memoryStore(initial)
  let subscribers = 0
  let teardown = () => {}
  const readonly: ReadonlyStore<T> = {
    get: store.get,
    subscribe(listener) {
      const off = store.subscribe(listener)
      if (subscribers++ === 0) teardown = whileSubscribed(store.set)
      let done = false
      return () => {
        if (done) return
        done = true
        off()
        if (--subscribers === 0) teardown()
      }
    },
  }
  return { ...readonly, set: store.set, update: store.update, readonly }
}
