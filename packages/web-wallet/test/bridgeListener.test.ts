/**
 * The frame's listener: a valid message from its parent on the campaign origin is stored as
 * hand-off material and acknowledged with its nonce; everything else is ignored without a reply.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installBridge } from "../src/bridge/listener"
import { readHandoffMaterial } from "../src/platform/storage/handoffMaterial"

const CAMPAIGN = "https://launch.test.invalid"
const CRED = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCde"
const valid = () => ({
  v: 1,
  type: "handoff-material",
  nonce: "n-1",
  derivedAt: 1757000000000,
  rpId: "localhost",
  credentialId: CRED,
  pubkeyHex: "ab".repeat(64),
  candidates: { first: `0x${"11".repeat(32)}` },
})

let parent: MessagePort
let channel: MessageChannel
let acks: unknown[]
let uninstall: () => void

/** Delivers `data` to the frame as if from `source` on `origin`. */
const deliver = (data: unknown, origin = CAMPAIGN, source: MessagePort | null = parent) =>
  window.dispatchEvent(new MessageEvent("message", { data, origin, source }))
/**
 * The listener writes before it acks, so an ack is a task or two behind the delivery. Waiting for
 * the count the test expects keeps a slow write from reading as a missing ack.
 */
const acked = async (count: number) => {
  for (let i = 0; i < 50 && acks.length < count; i++) {
    await new Promise((r) => setTimeout(r, 0))
  }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  localStorage.clear()
  channel = new MessageChannel()
  parent = channel.port1
  // Bound to this test's own array: a late ack from a previous test must not land in it.
  const collected: unknown[] = []
  acks = collected
  channel.port2.onmessage = (e) => collected.push(e.data)
  channel.port2.start()
  uninstall = installBridge(
    window,
    { campaignOrigin: CAMPAIGN, rpId: "localhost" },
    { parentOf: () => parent },
  )
})

afterEach(() => {
  uninstall()
  channel.port2.onmessage = null
  channel.port2.close()
  parent.close()
})

describe("bridge listener", () => {
  it("stores a valid message from the parent on the campaign origin and acks its nonce", async () => {
    const post = vi.spyOn(parent, "postMessage")
    deliver(valid())
    await acked(1)
    expect(post).toHaveBeenCalledWith(
      { v: 1, type: "handoff-ack", nonce: "n-1" },
      { targetOrigin: CAMPAIGN },
    )
    expect(readHandoffMaterial()).toEqual({
      v: 1,
      derivedAt: 1757000000000,
      rpId: "localhost",
      credentialId: CRED,
      pubkeyHex: `0x${"ab".repeat(64)}`,
      candidates: { first: `0x${"11".repeat(32)}` },
    })
    expect(readHandoffMaterial()).not.toHaveProperty("transports")
    expect(acks).toEqual([{ v: 1, type: "handoff-ack", nonce: "n-1" }])
    // Nothing else moves: no pointers, no identity.
    expect(localStorage.getItem("webwallet.storageId")).toBeNull()
    expect(localStorage.getItem("webwallet.credentialId")).toBeNull()
    expect(localStorage.getItem("webwallet.identity")).toBeNull()
    expect(Object.keys(localStorage)).toEqual(["webwallet.handoff"])
  })

  it("stores the creation transports with the material when the message carries them", async () => {
    deliver({ ...valid(), transports: ["usb", "nfc"] })
    await acked(1)
    expect(readHandoffMaterial()?.transports).toEqual(["usb", "nfc"])
    expect(acks).toEqual([{ v: 1, type: "handoff-ack", nonce: "n-1" }])
    // A later message without a list replaces the material, list included.
    deliver({ ...valid(), nonce: "n-2" })
    await acked(2)
    expect(readHandoffMaterial()).not.toHaveProperty("transports")
  })

  it("a second valid message replaces the first", async () => {
    deliver(valid())
    deliver({ ...valid(), nonce: "n-2", derivedAt: 1757000001000 })
    await acked(2)
    expect(readHandoffMaterial()?.derivedAt).toBe(1757000001000)
    expect(acks.map((a) => (a as { nonce: string }).nonce)).toEqual(["n-1", "n-2"])
  })

  it.each([
    ["another origin", () => deliver(valid(), "https://evil.test.invalid")],
    [
      "a source that is not the parent",
      () => deliver(valid(), CAMPAIGN, new MessageChannel().port1),
    ],
    ["no source", () => deliver(valid(), CAMPAIGN, null)],
    ["the wrong version", () => deliver({ ...valid(), v: 2 })],
    ["another relying party", () => deliver({ ...valid(), rpId: "other.example" })],
    [
      "a candidate at the field order",
      () =>
        deliver({
          ...valid(),
          candidates: {
            first: "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
          },
        }),
    ],
    ["no candidates", () => deliver({ ...valid(), candidates: {} })],
    ["an empty transports list", () => deliver({ ...valid(), transports: [] })],
    ["a missing stamp", () => deliver({ ...valid(), derivedAt: undefined })],
    ["not an object", () => deliver("handoff-material")],
  ])("ignores %s: nothing written, no ack", async (_name, send) => {
    send()
    await flush()
    expect(readHandoffMaterial()).toBeNull()
    expect(localStorage.getItem("webwallet.handoff")).toBeNull()
    expect(acks).toEqual([])
  })

  it("does not ack a message whose write failed", async () => {
    uninstall()
    uninstall = installBridge(
      window,
      { campaignOrigin: CAMPAIGN, rpId: "localhost" },
      {
        parentOf: () => parent,
        write: () => {
          throw new Error("QuotaExceededError")
        },
      },
    )
    deliver(valid())
    await flush()
    expect(readHandoffMaterial()).toBeNull()
    expect(acks).toEqual([])
  })

  it("with no campaign origin configured, every message is ignored", async () => {
    uninstall()
    uninstall = installBridge(
      window,
      { campaignOrigin: "", rpId: "localhost" },
      { parentOf: () => parent },
    )
    deliver(valid())
    await flush()
    expect(readHandoffMaterial()).toBeNull()
    expect(acks).toEqual([])
  })

  it("a top-level page (no parent) accepts nothing", async () => {
    uninstall()
    uninstall = installBridge(window, { campaignOrigin: CAMPAIGN, rpId: "localhost" })
    deliver(valid())
    await flush()
    expect(readHandoffMaterial()).toBeNull()
  })

  it("stores the stamp as received; the wallet bounds it at the attempt", async () => {
    const write = vi.fn()
    uninstall()
    uninstall = installBridge(
      window,
      { campaignOrigin: CAMPAIGN, rpId: "localhost" },
      { parentOf: () => parent, write },
    )
    deliver({ ...valid(), derivedAt: 1 })
    await flush()
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ derivedAt: 1 }))
  })
})
