import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  DEFAULT_MAX_ATTEMPTS,
  PENDING_CONNECT_BACK_STORAGE_KEY,
  PendingConnectBackStorage,
  flushPendingConnectBacks,
  type ConnectBackSender,
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
  seed(key: string, value: string): void {
    this.store.set(key, value)
  }
  raw(key: string): string | undefined {
    return this.store.get(key)
  }
}

const UUID_A = "f47ac10b58cc4372a5670e02b2c3d479"
const UUID_B = "550e8400e29b41d4a716446655440000"
const PEER = "0xAbCdef0000000000000000000000000000001234"

const entry = (uuid: string) => ({
  uuid,
  peerXmtp: PEER,
  content: { version: 1, uuid },
})

const setup = (maxAgeMs?: number) => {
  PendingConnectBackStorage.resetForTests()
  const adapter = new InMemoryStorage()
  const storage = PendingConnectBackStorage.get(adapter, maxAgeMs)
  return { adapter, storage }
}

describe("PendingConnectBackStorage", () => {
  beforeEach(() => {
    PendingConnectBackStorage.resetForTests()
  })

  it("enqueue → list returns the entry with attempts: 0", async () => {
    const { storage } = setup()
    await storage.enqueue(entry(UUID_A), 1000)

    const list = await storage.list()
    expect(list).toEqual([
      {
        uuid: UUID_A,
        peerXmtp: PEER,
        content: { version: 1, uuid: UUID_A },
        attempts: 0,
        createdAt: 1000,
      },
    ])
  })

  it("enqueue of the same uuid replaces (no dup) and resets attempts", async () => {
    const { storage } = setup()
    await storage.enqueue(entry(UUID_A), 1000)
    await storage.recordAttempt(UUID_A)
    await storage.enqueue(entry(UUID_A), 2000) // re-scan

    const list = await storage.list()
    expect(list).toHaveLength(1)
    expect(list[0].attempts).toBe(0)
    expect(list[0].createdAt).toBe(2000)
  })

  it("remove deletes the entry; recordAttempt on an absent uuid is a no-op (returns 0)", async () => {
    const { storage } = setup()
    await storage.enqueue(entry(UUID_A))
    await storage.remove(UUID_A)
    expect(await storage.list()).toHaveLength(0)
    expect(await storage.recordAttempt(UUID_A)).toBe(0)
  })

  it("recordAttempt increments and persists", async () => {
    const { storage } = setup()
    await storage.enqueue(entry(UUID_A))
    expect(await storage.recordAttempt(UUID_A)).toBe(1)
    expect(await storage.recordAttempt(UUID_A)).toBe(2)
  })

  it("persists across instances (reload reads back the entry)", async () => {
    const { adapter, storage } = setup()
    await storage.enqueue(entry(UUID_A), Date.now())

    PendingConnectBackStorage.resetForTests()
    const reloaded = PendingConnectBackStorage.get(adapter)
    const list = await reloaded.list()
    expect(list).toHaveLength(1)
    expect(list[0].uuid).toBe(UUID_A)
  })

  it("prunes expired entries on load and persists the pruned map", async () => {
    const adapter = new InMemoryStorage()
    const now = Date.now()
    const maxAge = 1000
    adapter.seed(
      PENDING_CONNECT_BACK_STORAGE_KEY,
      JSON.stringify({
        [UUID_A]: {
          uuid: UUID_A,
          peerXmtp: PEER,
          content: { version: 1, uuid: UUID_A },
          attempts: 0,
          createdAt: now - 100,
        },
        [UUID_B]: {
          uuid: UUID_B,
          peerXmtp: PEER,
          content: { version: 1, uuid: UUID_B },
          attempts: 0,
          createdAt: now - 5000,
        },
      }),
    )

    PendingConnectBackStorage.resetForTests()
    const storage = PendingConnectBackStorage.get(adapter, maxAge)
    const list = await storage.list()
    expect(list.map((e) => e.uuid)).toEqual([UUID_A]) // stale UUID_B pruned

    const onDisk = JSON.parse(adapter.raw(PENDING_CONNECT_BACK_STORAGE_KEY)!)
    expect(Object.keys(onDisk)).toEqual([UUID_A])
  })

  it("drops a malformed record on load", async () => {
    const adapter = new InMemoryStorage()
    adapter.seed(
      PENDING_CONNECT_BACK_STORAGE_KEY,
      JSON.stringify({ [UUID_A]: { uuid: UUID_A, peerXmtp: PEER /* missing content/attempts */ } }),
    )
    PendingConnectBackStorage.resetForTests()
    const storage = PendingConnectBackStorage.get(adapter)
    expect(await storage.list()).toHaveLength(0)
  })
})

describe("flushPendingConnectBacks", () => {
  beforeEach(() => {
    PendingConnectBackStorage.resetForTests()
  })

  it("a successful send removes the entry", async () => {
    const { storage } = setup()
    await storage.enqueue(entry(UUID_A))
    const send = vi.fn(async () => ({ ok: true }))

    await flushPendingConnectBacks(storage, { sendConnectBack: send } as ConnectBackSender)

    expect(send).toHaveBeenCalledWith(PEER, { version: 1, uuid: UUID_A })
    expect(await storage.list()).toHaveLength(0)
  })

  it("a non-ok result records an attempt and keeps the entry (until the cap)", async () => {
    const { storage } = setup()
    await storage.enqueue(entry(UUID_A))
    const send = vi.fn(async () => ({ ok: false }))

    await flushPendingConnectBacks(storage, { sendConnectBack: send } as ConnectBackSender)

    const list = await storage.list()
    expect(list).toHaveLength(1)
    expect(list[0].attempts).toBe(1)
  })

  it("a throwing send records an attempt and keeps the entry", async () => {
    const { storage } = setup()
    await storage.enqueue(entry(UUID_A))
    const send = vi.fn(async () => {
      throw new Error("dm.send blew up")
    })

    await flushPendingConnectBacks(storage, { sendConnectBack: send } as ConnectBackSender)

    const list = await storage.list()
    expect(list).toHaveLength(1)
    expect(list[0].attempts).toBe(1)
  })

  it("gives up (removes the entry) once attempts exceed maxAttempts", async () => {
    const { storage } = setup()
    await storage.enqueue(entry(UUID_A))
    const send = vi.fn(async () => ({ ok: false }))

    // maxAttempts: 1 → the first failure pushes attempts to 1 (>= 1) → dropped.
    await flushPendingConnectBacks(storage, { sendConnectBack: send } as ConnectBackSender, {
      maxAttempts: 1,
    })

    expect(await storage.list()).toHaveLength(0)
  })

  it("processes multiple entries and one bad one doesn't stall the rest", async () => {
    const { storage } = setup()
    await storage.enqueue(entry(UUID_A))
    await storage.enqueue(entry(UUID_B))
    // A succeeds, B throws.
    const send = vi.fn(async (peer: string, content: { uuid: string }) => {
      if (content.uuid === UUID_B) throw new Error("boom")
      return { ok: true }
    })

    await flushPendingConnectBacks(storage, { sendConnectBack: send } as ConnectBackSender)

    const list = await storage.list()
    expect(list.map((e) => e.uuid)).toEqual([UUID_B]) // A delivered+removed, B retried
    expect(list[0].attempts).toBe(1)
  })

  it("a flush over an empty outbox is a no-op", async () => {
    const { storage } = setup()
    const send = vi.fn(async () => ({ ok: true }))
    await flushPendingConnectBacks(storage, { sendConnectBack: send } as ConnectBackSender)
    expect(send).not.toHaveBeenCalled()
  })

  it("DEFAULT_MAX_ATTEMPTS is a sane positive cap", () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBeGreaterThan(0)
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
    PendingConnectBackStorage.resetForTests()
    const a = PendingConnectBackStorage.get(adapter, undefined, lock)
    PendingConnectBackStorage.resetForTests()
    const b = PendingConnectBackStorage.get(adapter, undefined, lock)
    return { a, b }
  }

  it("enqueues from two stale contexts both survive under the injected lock", async () => {
    const adapter = new InMemoryStorage()
    const { a, b } = twoContexts(adapter, createSharedMutex())
    // Both contexts load the empty outbox first.
    await a.initialize()
    await b.initialize()

    const now = Date.now()
    await a.enqueue(entry(UUID_A), now)
    // B's cached view predates A's write; the locked re-read must pick it up.
    await b.enqueue(entry(UUID_B), now)

    const persisted = JSON.parse(adapter.raw(PENDING_CONNECT_BACK_STORAGE_KEY)!) as Record<
      string,
      unknown
    >
    expect(Object.keys(persisted).sort()).toEqual([UUID_B, UUID_A].sort())
  })

  it("recordAttempt from a stale context does not clobber another context's enqueue", async () => {
    const adapter = new InMemoryStorage()
    const { a, b } = twoContexts(adapter, createSharedMutex())
    const now = Date.now()
    await a.enqueue(entry(UUID_A), now)
    await b.initialize()

    await a.enqueue(entry(UUID_B), now)
    expect(await b.recordAttempt(UUID_A)).toBe(1)

    const persisted = JSON.parse(adapter.raw(PENDING_CONNECT_BACK_STORAGE_KEY)!) as Record<
      string,
      { attempts: number }
    >
    expect(Object.keys(persisted).sort()).toEqual([UUID_B, UUID_A].sort())
    expect(persisted[UUID_A].attempts).toBe(1)
  })

  it("subscribe-driven invalidation reflects another context's write", async () => {
    const adapter = new SubscribableStorage()
    PendingConnectBackStorage.resetForTests()
    const storage = PendingConnectBackStorage.get(adapter)
    expect(await storage.list()).toEqual([])

    const now = Date.now()
    await adapter.setItem(
      PENDING_CONNECT_BACK_STORAGE_KEY,
      JSON.stringify({ [UUID_A]: { ...entry(UUID_A), attempts: 0, createdAt: now } }),
    )
    adapter.notify(PENDING_CONNECT_BACK_STORAGE_KEY)

    expect((await storage.list()).map((e) => e.uuid)).toEqual([UUID_A])
  })
})
