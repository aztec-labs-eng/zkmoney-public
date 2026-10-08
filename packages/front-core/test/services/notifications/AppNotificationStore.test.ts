import { beforeEach, describe, expect, it, vi } from "vitest"
import { InMemoryStorageAdapter } from "../../__test-helpers__/InMemoryStorageAdapter"
import {
  APP_NOTIFICATION_LIMIT,
  APP_NOTIFICATION_STORAGE_KEY,
  AppNotificationStore,
  type CreateAppNotificationInput,
} from "../../../src/index.js"

const BASE_NOTIFICATION: CreateAppNotificationInput = {
  id: "bridge:deposit:0xabc:done",
  producer: "bridge",
  domain: "bridge",
  sourceId: "bridge:deposit:0xabc:done",
  title: "Deposit complete",
  description: "10 DAI arrived",
  timestampMs: 1_700_000_000_000,
  systemIcon: "checkmark.circle.fill",
  severity: "success",
  target: {
    type: "bridge.txDetail",
    bridgeKind: "deposit",
    sourceId: "0xabc",
  },
}

function notification(
  overrides: Partial<CreateAppNotificationInput> = {},
): CreateAppNotificationInput {
  return {
    ...BASE_NOTIFICATION,
    ...overrides,
  }
}

describe("AppNotificationStore", () => {
  let storage: InMemoryStorageAdapter
  let store: AppNotificationStore

  beforeEach(() => {
    storage = new InMemoryStorageAdapter()
    store = new AppNotificationStore(storage)
  })

  it("persists notifications and lists them newest-first", async () => {
    await store.createIfAbsent(notification({ id: "older", timestampMs: 100 }))
    await store.createIfAbsent(notification({ id: "newer", timestampMs: 200 }))

    expect(store.list().map((entry) => entry.id)).toEqual(["newer", "older"])

    const reloaded = new AppNotificationStore(storage)
    await reloaded.load()
    expect(reloaded.list().map((entry) => entry.id)).toEqual(["newer", "older"])
  })

  it("marks a single notification read and emits the latest snapshot", async () => {
    await store.createIfAbsent(notification({ id: "read-me" }))
    await store.load()
    const changed = vi.fn()
    store.onListChanged(changed)

    const updated = await store.markRead("read-me", 1_700_000_000_500)

    expect(updated?.read).toBe(true)
    expect(updated?.readAt).toBe(1_700_000_000_500)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed.mock.calls[0][0][0]).toMatchObject({ id: "read-me", read: true })
  })

  it("discards readAt for unread notifications and preserves it for read ones", async () => {
    const unread = await store.createIfAbsent(
      notification({ id: "unread-with-read-at", read: false, readAt: 123 }),
    )
    const read = await store.createIfAbsent(
      notification({ id: "read-with-read-at", read: true, readAt: 456 }),
    )

    expect(unread.entry.read).toBe(false)
    expect(unread.entry.readAt).toBeUndefined()
    expect(read.entry.read).toBe(true)
    expect(read.entry.readAt).toBe(456)
  })

  it("marks all notifications read without deleting entries", async () => {
    await store.createIfAbsent(notification({ id: "one", timestampMs: 100 }))
    await store.createIfAbsent(notification({ id: "two", timestampMs: 200 }))
    await store.load()
    const changed = vi.fn()
    store.onListChanged(changed)

    await store.markAllRead(1_700_000_001_000)

    expect(store.list()).toHaveLength(2)
    expect(store.list().every((entry) => entry.read)).toBe(true)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it("dismiss hides the entry, marks it read, and keeps the first dismissedAt", async () => {
    await store.createIfAbsent(notification({ id: "a" }))
    await store.dismiss("a", 500)
    expect(store.get("a")).toMatchObject({ read: true, readAt: 500, dismissedAt: 500 })

    await store.dismiss("a", 900)
    expect(store.get("a")?.dismissedAt).toBe(500)
  })

  it("dismiss preserves an existing readAt", async () => {
    await store.createIfAbsent(notification({ id: "a" }))
    await store.markRead("a", 100)
    await store.dismiss("a", 500)
    expect(store.get("a")).toMatchObject({ readAt: 100, dismissedAt: 500 })
  })

  it("dismissAll stamps every live entry and skips the write when nothing is live", async () => {
    await store.createIfAbsent(notification({ id: "a" }))
    await store.createIfAbsent(notification({ id: "b" }))
    await store.dismiss("a", 100)
    await store.dismissAll(500)
    expect(store.get("a")?.dismissedAt).toBe(100)
    expect(store.get("b")?.dismissedAt).toBe(500)

    const writes = vi.spyOn(storage, "setItem")
    await store.dismissAll(900)
    expect(writes).not.toHaveBeenCalled()
  })

  it("dismissAll can leave live rows to their producer, in one write", async () => {
    await store.createIfAbsent(notification({ id: "live", pending: true }))
    await store.createIfAbsent(notification({ id: "done" }))
    const writes = vi.spyOn(storage, "setItem")
    await store.dismissAll(500, { keepPending: true })
    expect(writes).toHaveBeenCalledTimes(1)
    expect(store.get("live")?.dismissedAt).toBeUndefined()
    expect(store.get("done")?.dismissedAt).toBe(500)
    writes.mockClear()
    await store.dismissAll(900, { keepPending: true })
    expect(writes).not.toHaveBeenCalled()
  })

  it("remove deletes the entry, so its id is minted again", async () => {
    await store.createIfAbsent(notification({ id: "a", title: "First" }))
    await store.createIfAbsent(notification({ id: "b" }))
    await store.dismiss("a", 500)
    const changed = vi.fn()
    store.onListChanged(changed)

    await store.remove("a")
    expect(store.list().map((entry) => entry.id)).toEqual(["b"])
    expect(changed).toHaveBeenCalledTimes(1)
    const reloaded = new AppNotificationStore(storage)
    await reloaded.load()
    expect(reloaded.get("a")).toBeNull()

    const { created } = await store.createIfAbsent(notification({ id: "a", title: "Second" }))
    expect(created).toBe(true)
    expect(store.get("a")).toMatchObject({ title: "Second", read: false })
    expect(store.get("a")?.dismissedAt).toBeUndefined()
  })

  it("remove skips the write when the entry is absent", async () => {
    await store.createIfAbsent(notification({ id: "a" }))
    const writes = vi.spyOn(storage, "setItem")
    await store.remove("missing")
    expect(writes).not.toHaveBeenCalled()
    expect(store.list().map((entry) => entry.id)).toEqual(["a"])
  })

  it("a remove landing inside another mutation keeps the removal", async () => {
    for (let ticks = 0; ticks < 10; ticks++) {
      const fresh = new AppNotificationStore(new InMemoryStorageAdapter())
      await fresh.createIfAbsent(notification({ id: "a" }))
      const read = fresh.markRead("a", 500)
      for (let i = 0; i < ticks; i++) await Promise.resolve()
      await Promise.all([read, fresh.remove("a")])
      expect(fresh.get("a")).toBeNull()
    }
  })

  it("a dismiss followed by markAllRead in the same tick keeps the dismissal", async () => {
    await store.createIfAbsent(notification({ id: "a" }))
    await store.createIfAbsent(notification({ id: "b" }))
    await Promise.all([store.dismiss("a", 500), store.markAllRead(600)])
    expect(store.get("a")?.dismissedAt).toBe(500)
    expect(store.get("b")?.read).toBe(true)
    expect(store.get("b")?.dismissedAt).toBeUndefined()
  })

  it("dedupes by notification id and preserves existing read state", async () => {
    await store.createIfAbsent(notification({ id: "same-id", title: "Original" }))
    await store.markRead("same-id", 123)

    const result = await store.createIfAbsent(notification({ id: "same-id", title: "Replacement" }))

    expect(result.created).toBe(false)
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]).toMatchObject({
      title: "Original",
      read: true,
      readAt: 123,
    })
  })

  it("enforces a single global APP_NOTIFICATION_LIMIT cap across producers", async () => {
    const overflow = APP_NOTIFICATION_LIMIT + 2
    for (let index = 0; index < overflow; index++) {
      await store.createIfAbsent(
        notification({
          id: `entry-${index}`,
          producer: index % 2 === 0 ? "bridge" : "paylink",
          domain: index % 2 === 0 ? "bridge" : "paylink",
          timestampMs: index,
        }),
      )
    }

    const list = store.list()
    expect(list).toHaveLength(APP_NOTIFICATION_LIMIT)
    expect(list[0].id).toBe(`entry-${overflow - 1}`)
    expect(list.at(-1)?.id).toBe(`entry-${overflow - APP_NOTIFICATION_LIMIT}`)
  })

  it("enforces the global cap when loading legacy oversized storage", async () => {
    const legacyEntries: Record<string, CreateAppNotificationInput & { read: boolean }> = {}
    for (let index = 0; index < APP_NOTIFICATION_LIMIT + 2; index++) {
      const entry = notification({
        id: `legacy-${index}`,
        timestampMs: index,
      })
      legacyEntries[entry.id] = {
        ...entry,
        read: false,
      }
    }
    await storage.setItem(APP_NOTIFICATION_STORAGE_KEY, JSON.stringify(legacyEntries))

    await store.load()

    const list = store.list()
    expect(list).toHaveLength(APP_NOTIFICATION_LIMIT)
    expect(list[0].id).toBe(`legacy-${APP_NOTIFICATION_LIMIT + 1}`)
    expect(list.at(-1)?.id).toBe("legacy-2")

    const persisted = JSON.parse(
      (await storage.getItem(APP_NOTIFICATION_STORAGE_KEY)) ?? "{}",
    ) as Record<string, unknown>
    expect(Object.keys(persisted)).toHaveLength(APP_NOTIFICATION_LIMIT)
    expect(persisted["legacy-0"]).toBeUndefined()
    expect(persisted["legacy-1"]).toBeUndefined()
  })

  it("preserves target metadata", async () => {
    const { entry } = await store.createIfAbsent(notification())

    expect(entry.target).toEqual(BASE_NOTIFICATION.target)
  })

  it("setTarget rewrites where an entry opens and nothing else", async () => {
    await store.createIfAbsent(notification({ read: true, readAt: 5 }))
    await store.dismiss(BASE_NOTIFICATION.id, 7)
    const target = { type: "registration.pending", tag: "alice" }

    expect((await store.setTarget(BASE_NOTIFICATION.id, target))?.target).toEqual(target)
    expect(store.list()[0]).toMatchObject({
      title: "Deposit complete",
      target,
      read: true,
      readAt: 5,
      dismissedAt: 7,
    })
    expect(await store.setTarget("missing", target)).toBeNull()
  })

  it("upserts a live entry in place, keeping read state", async () => {
    await store.upsert(notification({ description: "Sweeping", pending: true }))
    await store.markRead(BASE_NOTIFICATION.id)
    await store.upsert(notification({ description: "Crediting your balance", pending: true }))

    expect(store.list()).toMatchObject([
      { description: "Crediting your balance", pending: true, read: true },
    ])
  })

  it("shows a dismissed live entry again once its producer asserts it, same text or not", async () => {
    await store.upsert(notification({ description: "Sweeping", pending: true }))
    await store.dismiss(BASE_NOTIFICATION.id)
    expect(store.list()[0].dismissedAt).toBeDefined()

    await store.upsert(notification({ description: "Sweeping", pending: true }))
    expect(store.list()[0].dismissedAt).toBeUndefined()
    expect(store.list()).toHaveLength(1)

    await store.dismiss(BASE_NOTIFICATION.id)
    await store.upsert(notification({ description: "Crediting your balance", pending: true }))
    expect(store.list()[0].dismissedAt).toBeUndefined()
  })

  it("leaves a dismissed settled entry hidden until its text changes", async () => {
    await store.upsert(notification({ description: "2 deposits in transit" }))
    await store.dismiss(BASE_NOTIFICATION.id)

    await store.upsert(notification({ description: "2 deposits in transit" }))
    expect(store.list()[0].dismissedAt).toBeDefined()

    await store.upsert(notification({ description: "3 deposits in transit" }))
    expect(store.list()[0].dismissedAt).toBeUndefined()
  })

  it("loads corrupted storage as an empty list", async () => {
    await storage.setItem(APP_NOTIFICATION_STORAGE_KEY, "{not-json")

    await store.load()

    expect(store.list()).toEqual([])
  })

  it("notifies subscribers after create and mark-read", async () => {
    await store.load()
    const changed = vi.fn()
    store.onListChanged(changed)

    await store.createIfAbsent(notification({ id: "created" }))
    await store.markRead("created", 999)

    expect(changed).toHaveBeenCalledTimes(2)
    expect(changed.mock.calls[0][0]).toEqual([expect.objectContaining({ id: "created" })])
    expect(changed.mock.calls[1][0]).toEqual([
      expect.objectContaining({ id: "created", read: true }),
    ])
  })
})
