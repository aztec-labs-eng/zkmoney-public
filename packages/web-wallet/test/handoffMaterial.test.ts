/**
 * The bridge's hand-off material: its shape on disk, who may take it and when, and the wait for a
 * write that has not landed yet.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { clearActiveStorage } from "../src/platform/storage/activeStorage"
import {
  awaitHandoffMaterial,
  HANDOFF_MAX_AGE_MS,
  readHandoffMaterial,
  sweepExpiredHandoffMaterial,
  takeHandoffMaterial,
  writeHandoffMaterial,
  type HandoffMaterial,
} from "../src/platform/storage/handoffMaterial"

const RP = "localhost"
const now = 1_700_000_000_000
const material = (over: Partial<HandoffMaterial> = {}): HandoffMaterial => ({
  v: 1,
  derivedAt: now - 5_000,
  rpId: RP,
  credentialId: "cred",
  pubkeyHex: `0x${"ab".repeat(64)}`,
  candidates: { first: `0x${"11".repeat(32)}` },
  ...over,
})

describe("hand-off material", () => {
  beforeEach(() => localStorage.clear())

  it("is taken once, by the hand-off naming its credential", async () => {
    await writeHandoffMaterial(material())
    expect(await takeHandoffMaterial("cred", RP, now)).toEqual(material())
    expect(readHandoffMaterial()).toBeNull()
    expect(await takeHandoffMaterial("cred", RP, now)).toBeNull()
  })

  it("two takes at once hand it to exactly one", async () => {
    await writeHandoffMaterial(material())
    const taken = await Promise.all([
      takeHandoffMaterial("cred", RP, now),
      takeHandoffMaterial("cred", RP, now),
    ])
    expect(taken.filter((m) => m !== null)).toHaveLength(1)
    expect(readHandoffMaterial()).toBeNull()
  })

  it("stays for its own hand-off when another credential asks", async () => {
    await writeHandoffMaterial(material())
    expect(await takeHandoffMaterial("other", RP, now)).toBeNull()
    expect(readHandoffMaterial()).toEqual(material())
  })

  it("is removed unread under another relying party", async () => {
    await writeHandoffMaterial(material({ rpId: "elsewhere.example" }))
    expect(await takeHandoffMaterial("cred", RP, now)).toBeNull()
    expect(readHandoffMaterial()).toBeNull()
  })

  it.each([
    ["older than ten minutes", now - HANDOFF_MAX_AGE_MS - 1],
    ["two minutes in the future", now + 2 * 60_000],
    ["not a safe integer", Number.MAX_SAFE_INTEGER + 2],
  ])("a stamp %s is refused and the material removed", async (_name, derivedAt) => {
    await writeHandoffMaterial(material({ derivedAt }))
    expect(await takeHandoffMaterial("cred", RP, now)).toBeNull()
    expect(readHandoffMaterial()).toBeNull()
  })

  it("a stamp thirty seconds ahead, or just inside ten minutes, is accepted", async () => {
    await writeHandoffMaterial(material({ derivedAt: now + 30_000 }))
    expect(await takeHandoffMaterial("cred", RP, now)).not.toBeNull()
    await writeHandoffMaterial(material({ derivedAt: now - HANDOFF_MAX_AGE_MS }))
    expect(await takeHandoffMaterial("cred", RP, now)).not.toBeNull()
  })

  it.each([
    ["no candidates", JSON.stringify({ ...material(), candidates: {} })],
    ["a short candidate", JSON.stringify({ ...material(), candidates: { first: "0x11" } })],
    ["a short key", JSON.stringify({ ...material(), pubkeyHex: "0xab" })],
    ["a string for transports", JSON.stringify({ ...material(), transports: "usb" })],
    ["a number among the transports", JSON.stringify({ ...material(), transports: ["usb", 1] })],
    ["null for transports", JSON.stringify({ ...material(), transports: null })],
    ["not json", "{"],
  ])("a blob the bridge would not write (%s) is removed on read", (_name, raw) => {
    localStorage.setItem("webwallet.handoff", raw)
    expect(readHandoffMaterial()).toBeNull()
    expect(localStorage.getItem("webwallet.handoff")).toBeNull()
  })

  it("the creation transports ride with the material, verbatim, and only when written", async () => {
    await writeHandoffMaterial(material({ transports: ["usb", "future-token"] }))
    expect(await takeHandoffMaterial("cred", RP, now)).toEqual(
      material({ transports: ["usb", "future-token"] }),
    )
    await writeHandoffMaterial(material())
    expect(await takeHandoffMaterial("cred", RP, now)).not.toHaveProperty("transports")
  })

  it("a 32-byte candidate above the field modulus is stored as given; the reader of the key decides", async () => {
    const above = `0x${"ff".repeat(32)}`
    await writeHandoffMaterial(material({ candidates: { first: above } }))
    expect(readHandoffMaterial()?.candidates).toEqual({ first: above })
  })

  it("a logout's pointer clear leaves it alone", async () => {
    await writeHandoffMaterial(material())
    clearActiveStorage()
    expect(readHandoffMaterial()).toEqual(material())
  })

  it("the bridge's write waits for a take or sweep that holds the lock", async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const holding = navigator.locks.request("webwallet.handoff", async () => {
      await held
    })
    const write = writeHandoffMaterial(material())
    await Promise.resolve()
    await Promise.resolve()
    expect(readHandoffMaterial()).toBeNull()
    release()
    await holding
    await write
    expect(readHandoffMaterial()).toEqual(material())
  })

  it("the boot sweep removes material past its window and keeps live material", async () => {
    await writeHandoffMaterial(material({ derivedAt: now - HANDOFF_MAX_AGE_MS - 1 }))
    await sweepExpiredHandoffMaterial(now)
    expect(readHandoffMaterial()).toBeNull()

    await writeHandoffMaterial(material({ derivedAt: now + 120_000 }))
    await sweepExpiredHandoffMaterial(now)
    expect(readHandoffMaterial()).toBeNull()

    await writeHandoffMaterial(material())
    await sweepExpiredHandoffMaterial(now)
    expect(readHandoffMaterial()).toEqual(material())
  })

  describe("awaiting the bridge's write", () => {
    it("returns at once when the material is already there", async () => {
      await writeHandoffMaterial(material({ derivedAt: Date.now() }))
      expect(await awaitHandoffMaterial("cred", RP, 2_000)).not.toBeNull()
    })

    it("takes material another tab writes while it waits", async () => {
      const pending = awaitHandoffMaterial("cred", RP, 2_000)
      await new Promise((r) => setTimeout(r, 5))
      await writeHandoffMaterial(material({ derivedAt: Date.now() }))
      window.dispatchEvent(new StorageEvent("storage", { key: "webwallet.handoff" }))
      expect(await pending).not.toBeNull()
      expect(readHandoffMaterial()).toBeNull()
    })

    it("a write landing between the listener and the first read is not missed", async () => {
      // The listener is armed before the first take runs, so a write that lands in the same tick
      // is either seen by the take or by the event; either way the wait ends with the material.
      const pending = awaitHandoffMaterial("cred", RP, 2_000)
      await writeHandoffMaterial(material({ derivedAt: Date.now() }))
      window.dispatchEvent(new StorageEvent("storage", { key: "webwallet.handoff" }))
      expect(await pending).not.toBeNull()
    })

    it("gives up after the wait with nothing there", async () => {
      expect(await awaitHandoffMaterial("cred", RP, 10)).toBeNull()
    })

    it("does not wait at all with a zero budget", async () => {
      const started = Date.now()
      expect(await awaitHandoffMaterial("cred", RP, 0)).toBeNull()
      expect(Date.now() - started).toBeLessThan(50)
    })

    it("a take that fails counts as no material and releases the listener", async () => {
      const removed = vi.spyOn(window, "removeEventListener")
      const blocked = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("blocked")
      })
      try {
        const started = Date.now()
        expect(await awaitHandoffMaterial("cred", RP, 2_000)).toBeNull()
        expect(Date.now() - started).toBeLessThan(500)
      } finally {
        blocked.mockRestore()
      }
      expect(removed.mock.calls.some(([type]) => type === "storage")).toBe(true)
      removed.mockRestore()
    })
  })
})
