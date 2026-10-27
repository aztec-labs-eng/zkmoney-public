import { batch } from "./store"

/**
 * The storage a persistent store runs over: sync reads from an in-memory copy, writes applied to
 * that copy at once and saved in call order. `setItem`/`removeItem` save in the background;
 * `commitTransaction` and `batch` resolve once their writes are durable, all or none. A write that
 * fails to save drops out of every read.
 */
export interface KvStore {
  getItem(key: string): string | null
  keys(): string[]
  setItem(key: string, value: string): void
  removeItem(key: string): void
  /** Writes `ops` as one transaction; `null` removes. */
  commitTransaction(ops: readonly KvOp[]): Promise<void>
  /** Runs `write` synchronously and saves every write it makes as one transaction. */
  batch(write: () => void): Promise<void>
  /**
   * Hears each transaction's writes once they are saved, before its promise resolves. The engine's
   * kvs run a transaction's listeners in one store `batch`.
   */
  onCommit(listener: (ops: readonly KvOp[]) => void): () => void
}

export type KvOp = readonly [key: string, value: string | null]

/** A `KvStore` that keeps nothing past the process. `entries` is shared, so a test can inspect it. */
export function createMemoryKv(entries: Map<string, string> = new Map()): KvStore {
  /** The open batch's writes, heard once it ends. */
  let batched: KvOp[] | undefined
  const listeners = new Set<(ops: readonly KvOp[]) => void>()
  const notify = (ops: readonly KvOp[]) =>
    batch(() => {
      for (const listener of [...listeners]) listener(ops)
    })
  const apply = (ops: readonly KvOp[]) => {
    for (const [key, value] of ops) {
      if (value === null) entries.delete(key)
      else entries.set(key, value)
    }
    if (batched) batched.push(...ops)
    else notify(ops)
  }
  return {
    getItem: (key) => entries.get(key) ?? null,
    keys: () => [...entries.keys()],
    setItem: (key, value) => apply([[key, value]]),
    removeItem: (key) => apply([[key, null]]),
    commitTransaction(ops) {
      apply(ops)
      return Promise.resolve()
    },
    batch(write) {
      if (batched) {
        write()
        return Promise.resolve()
      }
      const before = new Map(entries)
      const ops: KvOp[] = []
      batched = ops
      try {
        write()
      } catch (e) {
        entries.clear()
        for (const [key, value] of before) entries.set(key, value)
        throw e
      } finally {
        batched = undefined
      }
      if (ops.length > 0) notify(ops)
      return Promise.resolve()
    },
    onCommit(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/**
 * `kv` under `prefix`: keys outside it are invisible, and keys inside read without it. Aborting
 * `signal` releases every `onCommit` made through it.
 */
export function prefixedKv(kv: KvStore, prefix: string, signal?: AbortSignal): KvStore {
  const at = (key: string) => prefix + key
  const listeners = new Set<(ops: readonly KvOp[]) => void>()
  let off = () => {}
  signal?.addEventListener("abort", () => {
    listeners.clear()
    off()
  })
  return {
    getItem: (key) => kv.getItem(at(key)),
    keys: () =>
      kv
        .keys()
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length)),
    setItem: (key, value) => kv.setItem(at(key), value),
    removeItem: (key) => kv.removeItem(at(key)),
    commitTransaction: (ops) => kv.commitTransaction(ops.map(([key, value]) => [at(key), value])),
    batch: (write) => kv.batch(write),
    onCommit(listener) {
      if (signal?.aborted) return () => {}
      if (listeners.size === 0) {
        off = kv.onCommit((ops) => {
          const mine = ops.flatMap(([key, value]): KvOp[] =>
            key.startsWith(prefix) ? [[key.slice(prefix.length), value]] : [],
          )
          if (mine.length > 0) batch(() => [...listeners].forEach((l) => l(mine)))
        })
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) off()
      }
    },
  }
}
