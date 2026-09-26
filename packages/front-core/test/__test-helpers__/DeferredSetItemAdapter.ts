import type { IStorageAdapter } from "../../src/core/storages/adapter"

/**
 * IStorageAdapter for tests that need observable ordering of concurrent setItem calls.
 *
 * Invariant: `setItem` SYNCHRONOUSLY pushes an entry onto `pendingSetItems` before
 * returning the unresolved Promise. Do NOT make this `async` — the `async` keyword
 * yields a microtask before the body runs, which would break the negative-control
 * test where three direct `adapter.setItem()` calls must be observable as three
 * pending entries synchronously.
 *
 * The backing Map is only updated on `flushOne()` — tests can assert "setItem was
 * called but hasn't landed in storage yet" against `pendingSetItems.length` and
 * `getItem()` respectively.
 */
interface Pending {
  key: string
  value: string
  resolve: () => void
  reject: (err: Error) => void
}

export class DeferredSetItemAdapter implements IStorageAdapter {
  private data = new Map<string, string>()
  private pending: Pending[] = []

  /**
   * Read-only view over pending writes. Exposes only `key`/`value` so tests
   * can't accidentally resolve promises directly.
   */
  get pendingSetItems(): ReadonlyArray<{ key: string; value: string }> {
    return this.pending.map((p) => ({ key: p.key, value: p.value }))
  }

  async getItem(key: string): Promise<string | null> {
    return this.data.get(key) ?? null
  }

  setItem(key: string, value: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pending.push({
        key,
        value,
        resolve: () => {
          this.data.set(key, value)
          resolve()
        },
        reject,
      })
    })
  }

  async removeItem(key: string): Promise<void> {
    this.data.delete(key)
  }

  async clear(): Promise<void> {
    this.data.clear()
  }

  /**
   * Resolve the oldest pending `setItem`. Writes to the backing Map and splices
   * the entry off the queue. Returns true if a pending entry was resolved.
   */
  flushOne(): boolean {
    const next = this.pending.shift()
    if (!next) return false
    next.resolve()
    return true
  }

  /**
   * Reject the oldest pending `setItem` with the given error. Splices the entry
   * off the queue without writing to the backing Map.
   */
  failOne(err: Error): boolean {
    const next = this.pending.shift()
    if (!next) return false
    next.reject(err)
    return true
  }
}
