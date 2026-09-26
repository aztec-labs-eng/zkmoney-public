/** A module-global value with change notification, `useSyncExternalStore`-compatible. */
export function createExternalState<T>(initial: T): {
  get(): T
  set(next: T): void
  subscribe(listener: () => void): () => void
} {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (next: T) => {
      if (value === next) return
      value = next
      for (const listener of [...listeners]) listener()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
