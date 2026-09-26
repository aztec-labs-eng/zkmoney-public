import type { IStorageAdapter } from "../../src/core/storages/adapter"

/**
 * Minimal in-memory IStorageAdapter for unit tests. Map-backed, fully synchronous
 * under the hood (each method returns an immediately-resolved Promise).
 *
 * Use this for every store test EXCEPT persistChain serialization tests — those
 * need DeferredSetItemAdapter to produce observable interleaving.
 */
export class InMemoryStorageAdapter implements IStorageAdapter {
  private data = new Map<string, string>()

  async getItem(key: string): Promise<string | null> {
    return this.data.get(key) ?? null
  }

  async setItem(key: string, value: string): Promise<void> {
    this.data.set(key, value)
  }

  async removeItem(key: string): Promise<void> {
    this.data.delete(key)
  }

  async clear(): Promise<void> {
    this.data.clear()
  }
}
