import { beforeEach, describe, expect, it } from "vitest"
import {
  IssuedConnectStorage,
  ISSUED_CONNECT_STORAGE_KEY,
  type IStorageAdapter,
} from "../../src/index.js"

class InMemoryStorage implements IStorageAdapter {
  private store = new Map<string, string>()

  async getItem(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null
  }

  async setItem(key: string, value: string): Promise<void> {
    this.store.set(key, value)
  }

  async removeItem(key: string): Promise<void> {
    this.store.delete(key)
  }

  async clear(): Promise<void> {
    this.store.clear()
  }

  raw(key: string): string | undefined {
    return this.store.get(key)
  }

  seed(key: string, value: string): void {
    this.store.set(key, value)
  }
}

const UUID_A = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
const UUID_B = "550e8400-e29b-41d4-a716-446655440000"

const setup = (maxAgeMs?: number) => {
  IssuedConnectStorage.resetForTests()
  const adapter = new InMemoryStorage()
  const storage = IssuedConnectStorage.get(adapter, maxAgeMs)
  return { adapter, storage }
}

describe("IssuedConnectStorage", () => {
  beforeEach(() => {
    IssuedConnectStorage.resetForTests()
  })

  it("ISSUED_CONNECT_STORAGE_KEY pins to the literal string", () => {
    expect(ISSUED_CONNECT_STORAGE_KEY).toBe("obsidion_issued_connects")
  })

  it("recordHandshake → lookup round-trips the uuid record (createdAt only)", async () => {
    const { storage } = setup()
    await storage.recordHandshake(UUID_A, 1000)

    const got = await storage.lookup(UUID_A)
    expect(got).toEqual({ createdAt: 1000 })
  })

  it("recordHandshake entry survives a restart (single-add across relaunch)", async () => {
    const { adapter, storage } = setup()
    const createdAt = Date.now()
    await storage.recordHandshake(UUID_A, createdAt)

    IssuedConnectStorage.resetForTests()
    const reloaded = IssuedConnectStorage.get(adapter)
    expect(await reloaded.lookup(UUID_A)).toEqual({ createdAt })
  })

  it("lookup of an unknown UUID returns null (no match, not an error)", async () => {
    const { storage } = setup()
    await storage.recordHandshake(UUID_A)
    expect(await storage.lookup(UUID_B)).toBeNull()
  })

  it("remove deletes the entry; subsequent lookup is null", async () => {
    const { storage } = setup()
    await storage.recordHandshake(UUID_A)
    await storage.remove(UUID_A)
    expect(await storage.lookup(UUID_A)).toBeNull()
  })

  it("remove of an absent UUID is a no-op (does not throw)", async () => {
    const { storage } = setup()
    await expect(storage.remove(UUID_B)).resolves.toBeUndefined()
  })

  it("persists across instances (reload reads back the entry)", async () => {
    const { adapter, storage } = setup()
    const createdAt = Date.now()
    await storage.recordHandshake(UUID_A, createdAt)

    // New instance over the same adapter — simulates a fresh app launch.
    IssuedConnectStorage.resetForTests()
    const reloaded = IssuedConnectStorage.get(adapter)
    expect(await reloaded.lookup(UUID_A)).toEqual({ createdAt })
  })

  it("prunes expired entries on load and persists the pruned map", async () => {
    const adapter = new InMemoryStorage()
    const now = Date.now()
    const maxAge = 1000

    // Seed one fresh + one expired entry directly on disk.
    adapter.seed(
      ISSUED_CONNECT_STORAGE_KEY,
      JSON.stringify({
        [UUID_A]: { createdAt: now - 100 },
        [UUID_B]: { createdAt: now - 5000 },
      }),
    )

    IssuedConnectStorage.resetForTests()
    const storage = IssuedConnectStorage.get(adapter, maxAge)

    expect(await storage.lookup(UUID_A)).not.toBeNull()
    expect(await storage.lookup(UUID_B)).toBeNull() // pruned

    // The pruned map was persisted (the stale entry is gone from disk too).
    const onDisk = JSON.parse(adapter.raw(ISSUED_CONNECT_STORAGE_KEY)!)
    expect(Object.keys(onDisk)).toEqual([UUID_A])
  })

  it("drops malformed records on load", async () => {
    const adapter = new InMemoryStorage()
    adapter.seed(
      ISSUED_CONNECT_STORAGE_KEY,
      JSON.stringify({
        [UUID_A]: { createdAt: Date.now() },
        [UUID_B]: { createdAt: "nope" }, // bad: createdAt not a number
      }),
    )

    IssuedConnectStorage.resetForTests()
    const storage = IssuedConnectStorage.get(adapter)
    expect(await storage.lookup(UUID_A)).not.toBeNull()
    expect(await storage.lookup(UUID_B)).toBeNull()
  })

  it("treats corrupt JSON as an empty store (and clears it)", async () => {
    const adapter = new InMemoryStorage()
    adapter.seed(ISSUED_CONNECT_STORAGE_KEY, "{not json")
    IssuedConnectStorage.resetForTests()
    const storage = IssuedConnectStorage.get(adapter)
    expect(await storage.lookup(UUID_A)).toBeNull()
  })
})

class SubscribableStorage extends InMemoryStorage {
  private subs = new Map<string, Set<() => void>>()
  subscribe(key: string, cb: () => void): () => void {
    const set = this.subs.get(key) ?? new Set()
    set.add(cb)
    this.subs.set(key, set)
    return () => set.delete(cb)
  }
  notify(key: string): void {
    for (const cb of this.subs.get(key) ?? []) cb()
  }
}

describe("multi-context write safety (web lock + subscribe seam)", () => {
  /** Shared FIFO mutex standing in for the web navigator.locks lock. */
  const createSharedMutex = () => {
    let tail: Promise<unknown> = Promise.resolve()
    return <T>(fn: () => Promise<T>): Promise<T> => {
      const run = tail.then(() => fn())
      tail = run.catch(() => undefined)
      return run
    }
  }

  const twoContexts = (
    adapter: IStorageAdapter,
    lock?: <T>(fn: () => Promise<T>) => Promise<T>,
  ) => {
    IssuedConnectStorage.resetForTests()
    const a = IssuedConnectStorage.get(adapter, undefined, lock)
    IssuedConnectStorage.resetForTests()
    const b = IssuedConnectStorage.get(adapter, undefined, lock)
    return { a, b }
  }

  it("records from two stale contexts both survive under the injected lock", async () => {
    const adapter = new InMemoryStorage()
    const { a, b } = twoContexts(adapter, createSharedMutex())
    // Both contexts load the empty map first.
    await a.initialize()
    await b.initialize()

    const now = Date.now()
    await a.recordHandshake(UUID_A, now)
    // B's cached view predates A's write; the locked re-read must pick it up.
    await b.recordHandshake(UUID_B, now)

    expect(await b.lookup(UUID_A)).toEqual({ createdAt: now })
    expect(JSON.parse(adapter.raw(ISSUED_CONNECT_STORAGE_KEY)!)).toEqual({
      [UUID_A]: { createdAt: now },
      [UUID_B]: { createdAt: now },
    })
  })

  it("remove from a stale context does not resurrect another context's record", async () => {
    const adapter = new InMemoryStorage()
    const { a, b } = twoContexts(adapter, createSharedMutex())
    const now = Date.now()
    await a.recordHandshake(UUID_A, now)
    await b.initialize()

    await a.recordHandshake(UUID_B, now)
    await b.remove(UUID_A)

    expect(JSON.parse(adapter.raw(ISSUED_CONNECT_STORAGE_KEY)!)).toEqual({
      [UUID_B]: { createdAt: now },
    })
  })

  it("subscribe-driven invalidation reflects another context's write", async () => {
    const adapter = new SubscribableStorage()
    IssuedConnectStorage.resetForTests()
    const storage = IssuedConnectStorage.get(adapter)
    expect(await storage.lookup(UUID_A)).toBeNull()

    const now = Date.now()
    await adapter.setItem(
      ISSUED_CONNECT_STORAGE_KEY,
      JSON.stringify({ [UUID_A]: { createdAt: now } }),
    )
    adapter.notify(ISSUED_CONNECT_STORAGE_KEY)

    expect(await storage.lookup(UUID_A)).toEqual({ createdAt: now })
  })
})
