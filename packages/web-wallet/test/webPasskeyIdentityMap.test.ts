/** Two writers of the breadcrumb map never erase each other: every mutation runs under one lock. */
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  WebPasskeyIdentityMap,
  hasRecordFor,
  listUsertagCandidates,
  rememberUsertag,
  usertagFor,
} from "../src/platform/auth/WebPasskeyIdentityMap"
import { WebStorageAdapter } from "../src/platform/storage/WebStorageAdapter"
import { walletStorage } from "../src/platform/storage/walletStorage"

const RP = "localhost"
const entry = (credentialId: string) => ({
  credentialId,
  l2Address: `0x${credentialId.repeat(32).slice(0, 64)}`,
  pubkey: "ab".repeat(64),
  isMskRoot: true,
})
/** The raw stored entry, timestamp included. */
const stored = (credentialId: string) =>
  JSON.parse(walletStorage.getItem("obsidion.obsidion_web_passkey_identity_map")!).entries[
    credentialId
  ]

describe("WebPasskeyIdentityMap creation list", () => {
  beforeEach(() => localStorage.clear())

  it("lands on a fresh entry, and a fresh entry without one stores no key", async () => {
    const map = new WebPasskeyIdentityMap(new WebStorageAdapter(), RP)
    await map.upsert({ ...entry("a"), transports: ["usb"] })
    expect((await map.get("a"))?.transports).toEqual(["usb"])
    await map.upsert(entry("b"))
    expect(stored("b")).not.toHaveProperty("transports")
    await map.upsert({ ...entry("c"), transports: undefined })
    expect(stored("c")).not.toHaveProperty("transports")
  })

  it("a stored list survives a re-record with another list or with none", async () => {
    const map = new WebPasskeyIdentityMap(new WebStorageAdapter(), RP)
    await map.upsert({ ...entry("a"), transports: ["hybrid", "internal"] })
    await map.upsert({ ...entry("a"), transports: ["usb"] })
    expect((await map.get("a"))?.transports).toEqual(["hybrid", "internal"])
    await map.upsert({ ...entry("a"), transports: undefined })
    expect((await map.get("a"))?.transports).toEqual(["hybrid", "internal"])
    await map.upsert({ ...entry("a"), l2Address: "0xmoved" })
    expect(await map.get("a")).toMatchObject({
      l2Address: "0xmoved",
      transports: ["hybrid", "internal"],
    })
  })

  it("two writers racing with different lists: the first to take the lock is kept", async () => {
    const map = new WebPasskeyIdentityMap(new WebStorageAdapter(), RP)
    expect(await map.get("a")).toBeUndefined()
    await Promise.all([
      map.upsert({ ...entry("a"), transports: ["hybrid", "internal"] }),
      map.upsert({ ...entry("a"), l2Address: "0xlater", transports: ["usb"] }),
    ])
    expect(await map.get("a")).toMatchObject({
      l2Address: "0xlater",
      transports: ["hybrid", "internal"],
    })
  })
})

describe("WebPasskeyIdentityMap under concurrent writers", () => {
  beforeEach(() => localStorage.clear())

  it("two concurrent upserts for different credentials both land", async () => {
    const map = new WebPasskeyIdentityMap(new WebStorageAdapter(), RP)
    await Promise.all([map.upsert(entry("a")), map.upsert(entry("b"))])
    expect(hasRecordFor(RP, "a")).toBe(true)
    expect(hasRecordFor(RP, "b")).toBe(true)
  })

  it("a usertag hint racing an upsert keeps both effects", async () => {
    const map = new WebPasskeyIdentityMap(new WebStorageAdapter(), RP)
    await map.upsert(entry("a"))
    await Promise.all([map.upsert(entry("b")), rememberUsertag(RP, "a", "alice")])
    expect(usertagFor(RP, "a")).toBe("alice")
    expect(hasRecordFor(RP, "b")).toBe(true)
  })

  it("an inferred list lands only on an entry with no creation list and no inference", async () => {
    const map = new WebPasskeyIdentityMap(new WebStorageAdapter(), RP)
    await map.upsert({ ...entry("a"), prfSlot: "first" })
    await rememberUsertag(RP, "a", "alice")
    const before = stored("a")

    await map.setInferredTransports("a", ["usb", "nfc"])
    expect((await map.get("a"))?.inferredTransports).toEqual(["usb", "nfc"])
    expect(stored("a")).toEqual({ ...before, inferredTransports: ["usb", "nfc"] })

    await map.setInferredTransports("a", ["ble"])
    expect((await map.get("a"))?.inferredTransports).toEqual(["usb", "nfc"])

    await map.upsert({ ...entry("b"), transports: ["hybrid"] })
    await map.setInferredTransports("b", ["usb"])
    expect((await map.get("b"))?.inferredTransports).toBeUndefined()

    await map.setInferredTransports("missing", ["usb"])
    expect(await map.get("missing")).toBeUndefined()
  })

  it("an entry under another RP is neither healed nor cleared", async () => {
    const other = new WebPasskeyIdentityMap(new WebStorageAdapter(), "other.example")
    await other.upsert(entry("a"))
    await other.setInferredTransports("a", ["nfc"])
    const before = stored("a")
    expect(before.inferredTransports).toEqual(["nfc"])
    const map = new WebPasskeyIdentityMap(new WebStorageAdapter(), RP)
    await map.setInferredTransports("a", undefined)
    expect(stored("a")).toEqual(before)
    await map.setInferredTransports("a", ["usb"])
    expect(stored("a")).toEqual(before)
  })

  it("clearing an inference removes that field and nothing else", async () => {
    const map = new WebPasskeyIdentityMap(new WebStorageAdapter(), RP)
    await map.upsert(entry("a"))
    const before = stored("a")
    await map.setInferredTransports("a", ["usb"])
    await map.setInferredTransports("a", undefined)
    expect(stored("a")).toEqual(before)
  })

  it("a re-record keeps a stored inference and cannot write one of its own", async () => {
    const map = new WebPasskeyIdentityMap(new WebStorageAdapter(), RP)
    await map.upsert(entry("a"))
    await map.setInferredTransports("a", ["usb"])
    await map.upsert({ ...entry("a"), inferredTransports: ["ble"] })
    expect((await map.get("a"))?.inferredTransports).toEqual(["usb"])
    await map.upsert({ ...entry("b"), inferredTransports: ["ble"] })
    expect((await map.get("b"))?.inferredTransports).toBeUndefined()
  })

  it("healing an older root never makes it the newest", async () => {
    const map = new WebPasskeyIdentityMap(new WebStorageAdapter(), RP)
    await map.upsert(entry("old"))
    await new Promise((resolve) => setTimeout(resolve, 2))
    await map.upsert(entry("new"))
    await map.setInferredTransports("old", ["usb"])
    expect((await map.getMskRoot())?.credentialId).toBe("new")
  })

  it("the root for an account is the one that opened it, not the newest; none when this browser has no root for it", async () => {
    const map = new WebPasskeyIdentityMap(new WebStorageAdapter(), RP)
    await map.upsert(entry("old"))
    await new Promise((resolve) => setTimeout(resolve, 2))
    await map.upsert(entry("new"))
    expect((await map.getMskRoot(entry("old").l2Address))?.credentialId).toBe("old")
    expect((await map.getMskRoot(entry("old").l2Address.toUpperCase()))?.credentialId).toBe("old")
    expect(await map.getMskRoot(`0x${"ff".repeat(32)}`)).toBeUndefined()
  })

  it("a creation list that lands first vetoes a heal issued against an older snapshot", async () => {
    const map = new WebPasskeyIdentityMap(new WebStorageAdapter(), RP)
    await map.upsert(entry("a"))
    await Promise.all([
      map.upsert({ ...entry("a"), transports: ["usb"] }),
      map.setInferredTransports("a", ["usb", "nfc"]),
    ])
    expect((await map.get("a"))?.inferredTransports).toBeUndefined()
  })

  it("a queued clear lands before a heal issued after it", async () => {
    const map = new WebPasskeyIdentityMap(new WebStorageAdapter(), RP)
    await map.upsert(entry("a"))
    await map.setInferredTransports("a", ["usb"])
    const cleared = map.setInferredTransports("a", undefined)
    const healed = map.setInferredTransports("a", ["nfc"])
    await Promise.all([cleared, healed])
    expect((await map.get("a"))?.inferredTransports).toEqual(["nfc"])
  })

  it("rememberUsertag asks stillOwns under the lock", async () => {
    const map = new WebPasskeyIdentityMap(new WebStorageAdapter(), RP)
    await map.upsert(entry("a"))
    let owns = true
    const writes = Promise.all([
      map.upsert(entry("b")),
      rememberUsertag(RP, "a", "alice", () => owns),
    ])
    owns = false
    await writes
    expect(usertagFor(RP, "a")).toBeUndefined()
    expect(hasRecordFor(RP, "b")).toBe(true)
  })

  it("a clear racing an upsert leaves the map empty or whole, never half", async () => {
    const map = new WebPasskeyIdentityMap(new WebStorageAdapter(), RP)
    await map.upsert(entry("a"))
    await Promise.all([map.upsert(entry("b")), map.clear()])
    const raw = walletStorage.getItem("obsidion.obsidion_web_passkey_identity_map")
    const entries = raw ? Object.keys(JSON.parse(raw).entries) : []
    expect([[], ["a", "b"]]).toContainEqual(entries.sort())
  })
})

describe("the remembered accounts a sign-in screen lists", () => {
  beforeEach(() => localStorage.clear())

  /** Upsert `credentialId` at a fixed clock, so the newest-first order is deterministic. */
  const upsertAt = async (map: WebPasskeyIdentityMap, at: number, meta = entry("x")) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(at)
    try {
      await map.upsert(meta)
    } finally {
      now.mockRestore()
    }
  }

  it("every root record with a claimed tag, newest first, in the candidate's key form", async () => {
    const map = new WebPasskeyIdentityMap(new WebStorageAdapter(), RP)
    await upsertAt(map, 1000, { ...entry("a"), pubkey: `0x${"AB".repeat(64)}` })
    await upsertAt(map, 2000, entry("b"))
    await upsertAt(map, 3000, entry("c"))
    await rememberUsertag(RP, "a", "alice")
    await rememberUsertag(RP, "c", "carol")
    expect(listUsertagCandidates(RP)).toEqual([
      { credentialId: "c", usertag: "carol", l2Address: entry("c").l2Address, pubkeyHex: "ab".repeat(64) },
      { credentialId: "a", usertag: "alice", l2Address: entry("a").l2Address, pubkeyHex: "ab".repeat(64) },
    ])
  })

  it("a hundred records come back whole; no cap here — the screen scrolls them", async () => {
    const map = new WebPasskeyIdentityMap(new WebStorageAdapter(), RP)
    for (let i = 0; i < 100; i++) {
      await upsertAt(map, i, entry(`k${i}`))
      await rememberUsertag(RP, `k${i}`, `user${i}`)
    }
    const listed = listUsertagCandidates(RP)
    expect(listed).toHaveLength(100)
    expect(listed[0]!.usertag).toBe("user99")
    expect(listed[99]!.usertag).toBe("user0")
  })

  it("another RP, a non-root record, a record with no address and one with no tag are left out", async () => {
    const map = new WebPasskeyIdentityMap(new WebStorageAdapter(), RP)
    await map.upsert(entry("untagged"))
    await map.upsert({ ...entry("nonroot"), isMskRoot: false })
    await rememberUsertag(RP, "nonroot", "nobody")
    await map.upsert({ ...entry("homeless"), l2Address: "" })
    await rememberUsertag(RP, "homeless", "drifter")
    await new WebPasskeyIdentityMap(new WebStorageAdapter(), "auth.zk.money").upsert(entry("z"))
    await rememberUsertag("auth.zk.money", "z", "zed")
    await map.upsert(entry("kept"))
    await rememberUsertag(RP, "kept", "keeper")
    expect(listUsertagCandidates(RP).map((c) => c.usertag)).toEqual(["keeper"])
  })

  it("an empty browser lists nothing", () => {
    expect(listUsertagCandidates(RP)).toEqual([])
  })
})

describe("WebPasskeyIdentityMap answered", () => {
  beforeEach(() => localStorage.clear())

  it("the latest answer wins: remote, then local, then remote again", async () => {
    const map = new WebPasskeyIdentityMap(new WebStorageAdapter(), RP)
    await map.upsert(entry("a"))
    const before = stored("a")

    await map.setAnswered("a", "remote")
    expect(stored("a")).toEqual({ ...before, answered: "remote" })
    await map.setAnswered("a", "local")
    expect(stored("a")).toEqual({ ...before, answered: "local" })
    await map.setAnswered("a", "remote")
    expect(stored("a")).toEqual({ ...before, answered: "remote" })
  })

  it("no entry, another RP's entry, or an attempt that ended: nothing is written", async () => {
    const map = new WebPasskeyIdentityMap(new WebStorageAdapter(), RP)
    await map.setAnswered("missing", "remote")
    expect(await map.get("missing")).toBeUndefined()

    await new WebPasskeyIdentityMap(new WebStorageAdapter(), "other.example").upsert(entry("b"))
    await map.setAnswered("b", "remote")
    expect(stored("b")).not.toHaveProperty("answered")

    await map.upsert(entry("c"))
    await map.setAnswered("c", "remote", () => false)
    expect(stored("c")).not.toHaveProperty("answered")
  })

  it("a re-record, a tag hint and a cleared inference all keep it", async () => {
    const map = new WebPasskeyIdentityMap(new WebStorageAdapter(), RP)
    await map.upsert(entry("a"))
    await map.setAnswered("a", "remote")
    await map.setInferredTransports("a", ["usb"])
    await map.setInferredTransports("a", undefined)
    await rememberUsertag(RP, "a", "alice")
    await map.upsert({ ...entry("a"), l2Address: "0xmoved" })
    expect(stored("a")).toMatchObject({
      answered: "remote",
      usertag: "alice",
      l2Address: "0xmoved",
    })
  })
})
