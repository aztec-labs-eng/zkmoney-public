import { describe, expect, it, vi } from "vitest"
import { CONFIG_STORAGE_KEY_PREFIX, LOCAL_CONFIG_DEFAULTS } from "@obsidion/core/constants"
import { LocalConfigStore } from "../../src/core/config/LocalConfigStore"
import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"
import { WatchableStorageAdapter } from "../__test-helpers__/WatchableStorageAdapter"

const DEV_MODE_KEY = CONFIG_STORAGE_KEY_PREFIX + "devMode"

describe("LocalConfigStore", () => {
  describe("hydration", () => {
    it("resolves a missing entry to the default", async () => {
      const service = new LocalConfigStore(new InMemoryStorageAdapter())
      await service.init()
      expect(service.getSnapshot()).toEqual(LOCAL_CONFIG_DEFAULTS)
      expect(service.get("devMode")).toBe(false)
    })

    it("hydrates a persisted value on init", async () => {
      const storage = new InMemoryStorageAdapter()
      await storage.setItem(DEV_MODE_KEY, "true")
      const service = new LocalConfigStore(storage)
      await service.init()
      expect(service.get("devMode")).toBe(true)
    })

    it("returns the default before init resolves", () => {
      const service = new LocalConfigStore(new InMemoryStorageAdapter())
      expect(service.get("devMode")).toBe(false)
    })

    it("init is idempotent", async () => {
      const storage = new WatchableStorageAdapter()
      const service = new LocalConfigStore(storage)
      await Promise.all([service.init(), service.init()])
      await service.init()
      expect(storage.watcherCount).toBe(1)
    })

    it("fails open when storage reads throw: init resolves and serves defaults", async () => {
      class BrokenReadAdapter extends InMemoryStorageAdapter {
        override async getItem(): Promise<string | null> {
          throw new Error("storage unavailable")
        }
      }
      const service = new LocalConfigStore(new BrokenReadAdapter())
      await expect(service.init()).resolves.toBeUndefined()
      expect(service.getSnapshot()).toEqual(LOCAL_CONFIG_DEFAULTS)
    })

    it("fails open when watch wiring throws", async () => {
      class BrokenWatchAdapter extends InMemoryStorageAdapter {
        watch(): () => void {
          throw new Error("watch unsupported")
        }
      }
      const service = new LocalConfigStore(new BrokenWatchAdapter())
      await expect(service.init()).resolves.toBeUndefined()
      expect(service.get("devMode")).toBe(false)
    })
  })

  describe("malformed values", () => {
    it("discards an unparseable entry and falls back to the default for that key", async () => {
      const storage = new InMemoryStorageAdapter()
      await storage.setItem(DEV_MODE_KEY, "not-json{")
      const service = new LocalConfigStore(storage)
      await service.init()
      expect(service.get("devMode")).toBe(false)
    })

    it("discards a type-mismatched entry", async () => {
      const storage = new InMemoryStorageAdapter()
      await storage.setItem(DEV_MODE_KEY, "42")
      const service = new LocalConfigStore(storage)
      await service.init()
      expect(service.get("devMode")).toBe(false)
    })
  })

  describe("set", () => {
    it("persists one JSON-encoded entry per key and notifies subscribers", async () => {
      const storage = new InMemoryStorageAdapter()
      const service = new LocalConfigStore(storage)
      await service.init()
      let notified = 0
      service.subscribe(() => notified++)
      const before = service.getSnapshot()

      await service.set("devMode", true)

      expect(await storage.getItem(DEV_MODE_KEY)).toBe("true")
      expect(notified).toBe(1)
      expect(service.getSnapshot()).not.toBe(before)
      expect(service.getSnapshot().devMode).toBe(true)
    })

    it("does not notify when the value is unchanged", async () => {
      const service = new LocalConfigStore(new InMemoryStorageAdapter())
      await service.init()
      const before = service.getSnapshot()
      let notified = 0
      service.subscribe(() => notified++)

      await service.set("devMode", false)

      expect(notified).toBe(0)
      expect(service.getSnapshot()).toBe(before)
    })

    it("unsubscribe stops notifications", async () => {
      const service = new LocalConfigStore(new InMemoryStorageAdapter())
      await service.init()
      let notified = 0
      const unsubscribe = service.subscribe(() => notified++)
      unsubscribe()
      await service.set("devMode", true)
      expect(notified).toBe(0)
    })
  })

  describe("reset", () => {
    it("removes the entry and falls back to the default", async () => {
      const storage = new InMemoryStorageAdapter()
      const service = new LocalConfigStore(storage)
      await service.init()
      await service.set("devMode", true)
      let notified = 0
      service.subscribe(() => notified++)

      await service.reset("devMode")

      expect(await storage.getItem(DEV_MODE_KEY)).toBeNull()
      expect(service.get("devMode")).toBe(false)
      expect(notified).toBe(1)
    })

    it("reset() without a key enumerates known keys and never calls clear()", async () => {
      class ClearGuardAdapter extends InMemoryStorageAdapter {
        override async clear(): Promise<void> {
          throw new Error("LocalConfigStore must never call adapter.clear()")
        }
      }
      const storage = new ClearGuardAdapter()
      // An entry outside the config prefix must survive a full reset.
      await storage.setItem("obsidion_contacts", "[]")
      const service = new LocalConfigStore(storage)
      await service.init()
      await service.set("devMode", true)

      await service.reset()

      expect(service.getSnapshot()).toEqual(LOCAL_CONFIG_DEFAULTS)
      expect(await storage.getItem(DEV_MODE_KEY)).toBeNull()
      expect(await storage.getItem("obsidion_contacts")).toBe("[]")
    })
  })

  describe("external-change invalidation", () => {
    it("re-reads a key written by another context and notifies subscribers", async () => {
      const storage = new WatchableStorageAdapter()
      const service = new LocalConfigStore(storage)
      await service.init()
      let notified = 0
      service.subscribe(() => notified++)

      await storage.externalSet(DEV_MODE_KEY, "true")

      await vi.waitFor(() => expect(service.get("devMode")).toBe(true))
      expect(notified).toBe(1)
    })

    it("falls back to the default when another context removes the entry", async () => {
      const storage = new WatchableStorageAdapter()
      const service = new LocalConfigStore(storage)
      await service.init()
      await service.set("devMode", true)

      await storage.externalRemove(DEV_MODE_KEY)

      await vi.waitFor(() => expect(service.get("devMode")).toBe(false))
    })

    it("ignores external writes to unknown keys under the prefix", async () => {
      const storage = new WatchableStorageAdapter()
      const service = new LocalConfigStore(storage)
      await service.init()
      const before = service.getSnapshot()
      let notified = 0
      service.subscribe(() => notified++)

      await storage.externalSet(CONFIG_STORAGE_KEY_PREFIX + "unknownKey", "true")
      // Let the async invalidation path settle before asserting nothing happened.
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(service.getSnapshot()).toBe(before)
      expect(notified).toBe(0)
    })

    it("dispose stops watching", async () => {
      const storage = new WatchableStorageAdapter()
      const service = new LocalConfigStore(storage)
      await service.init()
      expect(storage.watcherCount).toBe(1)
      service.dispose()
      expect(storage.watcherCount).toBe(0)
    })
  })
})
