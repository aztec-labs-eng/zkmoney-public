import { beforeEach, describe, expect, it } from "vitest"
import {
  PASSKEY_IDENTITY_MAP_KEY,
  WEB_STORAGE_PREFIX,
  WebStorageAdapter,
  holdsAccountRecords,
} from "../src/platform/storage/WebStorageAdapter"
import { clearActiveStorage, setActiveStorageId } from "../src/platform/storage/activeStorage"

const bind = (storageId: string | null) =>
  storageId ? setActiveStorageId(storageId) : clearActiveStorage()

describe("WebStorageAdapter", () => {
  const adapter = new WebStorageAdapter()

  // Tests run as an entered account; the global-key and no-account cases bind their own session.
  beforeEach(() => {
    localStorage.clear()
    bind("t")
  })

  it("round-trips values", async () => {
    await adapter.setItem("k", "v")
    expect(await adapter.getItem("k")).toBe("v")
  })

  it("returns null for missing keys", async () => {
    expect(await adapter.getItem("missing")).toBeNull()
  })

  it("removes and clears", async () => {
    await adapter.setItem("a", "1")
    await adapter.setItem("b", "2")
    await adapter.removeItem("a")
    expect(await adapter.getItem("a")).toBeNull()
    expect(await adapter.getItem("b")).toBe("2")
    await adapter.clear()
    expect(await adapter.getItem("b")).toBeNull()
  })

  it("namespaces its keys and clear() leaves foreign keys alone", async () => {
    await adapter.setItem("mine", "1")
    localStorage.setItem("webwallet.identity", "keep")
    expect(localStorage.getItem(`${WEB_STORAGE_PREFIX}t.mine`)).toBe("1")
    await adapter.clear()
    expect(await adapter.getItem("mine")).toBeNull()
    expect(localStorage.getItem("webwallet.identity")).toBe("keep")
  })

  it("keeps each account's keys apart and global keys shared", async () => {
    bind("aaa")
    await adapter.setItem("obsidion_contacts", "A")
    await adapter.setItem(PASSKEY_IDENTITY_MAP_KEY, "shared")
    await adapter.setItem("obsidion_config:analyticsAsked", "true")
    bind("bbb")
    expect(await adapter.getItem("obsidion_contacts")).toBeNull()
    expect(await adapter.getItem(PASSKEY_IDENTITY_MAP_KEY)).toBe("shared")
    expect(await adapter.getItem("obsidion_config:analyticsAsked")).toBe("true")
    await adapter.setItem("obsidion_contacts", "B")
    await adapter.clear()
    bind("aaa")
    expect(await adapter.getItem("obsidion_contacts")).toBe("A")
    bind(null)
    expect(localStorage.getItem("obsidion.aaa.obsidion_contacts")).toBe("A")
    expect(await adapter.getItem("obsidion_contacts")).toBeNull()
  })

  it("clear() without a bound account touches nothing", async () => {
    bind("aaa")
    await adapter.setItem("obsidion_contacts", "A")
    await adapter.setItem(PASSKEY_IDENTITY_MAP_KEY, "shared")
    bind(null)
    await adapter.clear()
    expect(localStorage.getItem("obsidion.aaa.obsidion_contacts")).toBe("A")
    expect(await adapter.getItem(PASSKEY_IDENTITY_MAP_KEY)).toBe("shared")
  })

  it("a pointer change moves every instance at once", async () => {
    const other = new WebStorageAdapter()
    bind("aaa")
    await adapter.setItem("k", "a")
    bind("bbb")
    await other.setItem("k", "b")
    expect(await adapter.getItem("k")).toBe("b")
    expect(localStorage.getItem("obsidion.aaa.k")).toBe("a")
    expect(localStorage.getItem("obsidion.bbb.k")).toBe("b")
  })

  describe("holdsAccountRecords", () => {
    const ID = "ab".repeat(32)

    it("finds a key written under that account", async () => {
      bind(ID)
      await adapter.setItem("obsidion_contacts", "A")
      expect(holdsAccountRecords(ID)).toBe(true)
    })

    it("ignores another account's keys", async () => {
      bind("cd".repeat(32))
      await adapter.setItem("obsidion_contacts", "C")
      expect(holdsAccountRecords(ID)).toBe(false)
    })

    it("ignores shared keys and keys written with no account", async () => {
      bind(ID)
      await adapter.setItem(PASSKEY_IDENTITY_MAP_KEY, "shared")
      await adapter.setItem("obsidion_config:analyticsAsked", "true")
      bind(null)
      await adapter.setItem("obsidion_withdrawals", "{}")
      expect(holdsAccountRecords(ID)).toBe(false)
    })

    it("ignores an id that only starts the same way", () => {
      localStorage.setItem(`${WEB_STORAGE_PREFIX}${ID}0.obsidion_contacts`, "A")
      expect(holdsAccountRecords(ID)).toBe(false)
    })

    it("answers no for empty storage", () => {
      localStorage.clear()
      expect(holdsAccountRecords(ID)).toBe(false)
    })
  })

  describe("watch", () => {
    // jsdom never fires cross-tab storage events, so simulate the browser
    // dispatching one for a write made by another tab.
    const dispatchStorageEvent = (key: string | null) =>
      window.dispatchEvent(new StorageEvent("storage", { key }))

    it("notifies for another tab's write under the prefix, with the namespace stripped", () => {
      const seen: string[] = []
      const unwatch = adapter.watch!("obsidion_config:", (key) => seen.push(key))
      dispatchStorageEvent(`${WEB_STORAGE_PREFIX}obsidion_config:devMode`)
      expect(seen).toEqual(["obsidion_config:devMode"])
      unwatch()
    })

    it("ignores keys outside the prefix and null-key clear events", () => {
      const seen: string[] = []
      const unwatch = adapter.watch!("obsidion_config:", (key) => seen.push(key))
      dispatchStorageEvent(`${WEB_STORAGE_PREFIX}obsidion_contacts`)
      dispatchStorageEvent("unrelated.key")
      dispatchStorageEvent(null)
      expect(seen).toEqual([])
      unwatch()
    })

    it("strips the account namespace from scoped keys", () => {
      const seen: string[] = []
      const unwatch = adapter.watch!("obsidion_contacts", (key) => seen.push(key))
      dispatchStorageEvent(`${WEB_STORAGE_PREFIX}t.obsidion_contacts`)
      dispatchStorageEvent(`${WEB_STORAGE_PREFIX}other.obsidion_contacts`)
      expect(seen).toEqual(["obsidion_contacts"])
      unwatch()
    })

    it("unwatch stops notifications", () => {
      const seen: string[] = []
      const unwatch = adapter.watch!("obsidion_config:", (key) => seen.push(key))
      unwatch()
      dispatchStorageEvent(`${WEB_STORAGE_PREFIX}obsidion_config:devMode`)
      expect(seen).toEqual([])
    })
  })
})
