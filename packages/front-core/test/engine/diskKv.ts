import type { KvOp, KvStore } from "../../src/engine/kv"
import { batch as storeBatch } from "../../src/engine/store"

type Entry = { ops: KvOp[]; settled: Promise<void>; resolve(): void; reject(e: unknown): void }

/**
 * A `KvStore` that saves the way walletStorage does: reads see writes still in flight, each write
 * lands in call order, and a failed one drops out of reads. Writes land on the next microtask, or
 * on `land()` while `hold(true)` is on; while `fail(true)` is on they fail instead.
 */
export function diskKv() {
  const saved = new Map<string, string>()
  const pending: Entry[] = []
  const listeners = new Set<(ops: readonly KvOp[]) => void>()
  let open: Entry | undefined
  let held = false
  let failing = false

  const settle = (entry: Entry) => {
    pending.splice(pending.indexOf(entry), 1)
    if (failing) return entry.reject(new Error("disk"))
    for (const [key, value] of entry.ops) {
      if (value === null) saved.delete(key)
      else saved.set(key, value)
    }
    storeBatch(() => {
      for (const listener of [...listeners]) listener(entry.ops)
    })
    entry.resolve()
  }
  const entry = (): Entry => {
    let settle!: Pick<Entry, "resolve" | "reject">
    const settled = new Promise<void>((resolve, reject) => (settle = { resolve, reject }))
    return { ops: [], settled, ...settle }
  }
  const queue = (e: Entry) => {
    pending.push(e)
    if (!held) queueMicrotask(() => pending.includes(e) && settle(e))
    return e.settled
  }
  const write = (ops: readonly KvOp[]) => {
    if (open) {
      open.ops.push(...ops)
      return open.settled
    }
    const e = entry()
    e.ops.push(...ops)
    return queue(e)
  }

  /** Background writes that failed, as walletStorage keeps them for `flush`. */
  const lost: unknown[] = []
  const background = (ops: readonly KvOp[]) => {
    write(ops).catch((e: unknown) => lost.push(e))
  }

  const kv: KvStore = {
    getItem(key) {
      for (let i = pending.length - 1; i >= 0; i--) {
        const ops = pending[i].ops
        for (let j = ops.length - 1; j >= 0; j--) if (ops[j][0] === key) return ops[j][1]
      }
      return saved.get(key) ?? null
    },
    keys() {
      const keys = new Set(saved.keys())
      for (const { ops } of pending) {
        for (const [key, value] of ops) {
          if (value === null) keys.delete(key)
          else keys.add(key)
        }
      }
      return [...keys]
    },
    setItem: (key, value) => background([[key, value]]),
    removeItem: (key) => background([[key, null]]),
    commitTransaction: write,
    batch(fn) {
      if (open) {
        fn()
        return open.settled
      }
      const e = entry()
      pending.push(e)
      open = e
      try {
        fn()
      } catch (err) {
        pending.splice(pending.indexOf(e), 1)
        throw err
      } finally {
        open = undefined
      }
      pending.splice(pending.indexOf(e), 1)
      return queue(e)
    },
    onCommit(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    kv,
    /** What has landed. */
    saved,
    hold: (on: boolean) => void (held = on),
    /** Lands, or fails, every write in flight, in order. */
    async land() {
      for (const e of [...pending]) settle(e)
      await Promise.resolve()
    },
    fail: (on: boolean) => void (failing = on),
  }
}
