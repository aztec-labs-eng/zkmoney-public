export interface IStorageAdapter {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
  clear(): Promise<void>
  /** Optional: notify when ANOTHER context writes a key with this prefix. Returns unwatch. */
  watch?(prefix: string, onChange: (key: string) => void): () => void
  subscribe?(key: string, cb: () => void): () => void
}

/**
 * Cross-context write mutex: runs `fn` exclusively against other holders of the same lock. Web
 * supplies a `navigator.locks`-backed implementation; when absent, callers run directly.
 */
export type StorageLock = <T>(fn: () => Promise<T>) => Promise<T>
