import type { IStorageAdapter } from "@obsidion/front-core"

// v5's stores stamp each record with the bundle's one active network, so histories take turns.
let historyTurn: Promise<unknown> = Promise.resolve()
export function takeTurn<T>(run: () => Promise<T>): Promise<T> {
  const turn = historyTurn.then(run)
  historyTurn = turn.catch(() => {})
  return turn
}

/** A store of the source wallet's own over `arg`, beside any the bundle already holds. */
export const fresh = <T, A>(store: { prototype: T }, arg: A): T =>
  new (store as unknown as new (arg: A) => T)(arg)

export const memoryStorage = (items: Map<string, string>): IStorageAdapter => ({
  getItem: async (key) => items.get(key) ?? null,
  setItem: async (key, value) => void items.set(key, value),
  removeItem: async (key) => void items.delete(key),
  clear: async () => items.clear(),
})
