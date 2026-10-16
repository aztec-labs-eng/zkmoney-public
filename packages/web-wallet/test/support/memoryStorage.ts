import type { IStorageAdapter } from "@obsidion/front-core"

/** A Map-backed storage adapter for tests: every call resolves at once. */
export class InMemoryStorageAdapter implements IStorageAdapter {
  private data = new Map<string, string>()
  async getItem(key: string) {
    return this.data.get(key) ?? null
  }
  async setItem(key: string, value: string) {
    this.data.set(key, value)
  }
  async removeItem(key: string) {
    this.data.delete(key)
  }
  async clear() {
    this.data.clear()
  }
}
