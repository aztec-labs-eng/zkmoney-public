import { InMemoryStorageAdapter } from "./InMemoryStorageAdapter"

/**
 * InMemoryStorageAdapter plus the optional watch capability. externalSet /
 * externalRemove simulate a write from another context (another tab): they
 * mutate storage and notify matching watchers, like the browser storage event.
 */
export class WatchableStorageAdapter extends InMemoryStorageAdapter {
  private watchers = new Set<{ prefix: string; onChange: (key: string) => void }>()

  watch(prefix: string, onChange: (key: string) => void): () => void {
    const watcher = { prefix, onChange }
    this.watchers.add(watcher)
    return () => {
      this.watchers.delete(watcher)
    }
  }

  get watcherCount(): number {
    return this.watchers.size
  }

  async externalSet(key: string, value: string): Promise<void> {
    await super.setItem(key, value)
    this.notify(key)
  }

  async externalRemove(key: string): Promise<void> {
    await super.removeItem(key)
    this.notify(key)
  }

  private notify(key: string): void {
    for (const { prefix, onChange } of this.watchers) {
      if (key.startsWith(prefix)) onChange(key)
    }
  }
}
