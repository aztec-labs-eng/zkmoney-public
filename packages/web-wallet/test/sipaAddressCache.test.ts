/**
 * The SIPA address cache decides which L1 address a sender is told to fund, and a wrong answer is
 * only visible once someone has already paid an address nobody sweeps. These are the three pieces
 * that carry that decision: what a stored entry is worth today, whether a stored entry is
 * trustworthy at all, and whether two derivations can be mistaken for one another.
 */
import { beforeEach, describe, expect, it } from "vitest"
import { walletStorage } from "../src/platform/storage/walletStorage"
import { testWalletDbs } from "./support/fakeWalletDb"
import type { Address } from "viem"
import {
  appendToSipaPool,
  nextSelfSipaNonce,
  readCachedSipa,
  readSipaPool,
  readUnpublishedSlots,
  takeFromSipaPool,
  writeCachedSipa,
} from "../src/features/deposit/sipaGateway"

const KEY = "webwallet.sipa.address.sandbox.0xpool.0xacct.alice"
const ADDR = `0x${"ab".repeat(20)}` as Address
const OTHER = `0x${"cd".repeat(20)}` as Address
const DAY = 20662

const entry = (over: Partial<Parameters<typeof writeCachedSipa>[1]> = {}) => ({
  address: ADDR,
  day: DAY,
  nonce: 4242,
  published: false,
  ...over,
})

describe("readCachedSipa", () => {
  beforeEach(() => localStorage.clear())

  it("round-trips a complete entry", () => {
    writeCachedSipa(KEY, entry())
    expect(readCachedSipa(KEY)).toEqual(entry())
  })

  it("returns null for an absent key", () => {
    expect(readCachedSipa(KEY)).toBeNull()
  })

  it("rejects an entry with no nonce", () => {
    // The nonce regenerates the message secret. Without it the publish step derives a DIFFERENT
    // address than the one already displayed, and marks the displayed one published anyway.
    walletStorage.setItem(KEY, JSON.stringify({ address: ADDR, day: DAY, published: false }))
    expect(readCachedSipa(KEY)).toBeNull()
  })

  it("rejects a non-integer nonce or day", () => {
    walletStorage.setItem(KEY, JSON.stringify(entry({ nonce: 1.5 })))
    expect(readCachedSipa(KEY)).toBeNull()
    walletStorage.setItem(KEY, JSON.stringify(entry({ day: "20662" as unknown as number })))
    expect(readCachedSipa(KEY)).toBeNull()
  })

  it("rejects a non-boolean published flag", () => {
    walletStorage.setItem(KEY, JSON.stringify(entry({ published: 1 as unknown as boolean })))
    expect(readCachedSipa(KEY)).toBeNull()
  })

  it("rejects a missing address", () => {
    walletStorage.setItem(KEY, JSON.stringify({ day: DAY, nonce: 4242, published: true }))
    expect(readCachedSipa(KEY)).toBeNull()
  })

  it("fails soft on corrupt JSON", () => {
    walletStorage.setItem(KEY, "{not json")
    expect(readCachedSipa(KEY)).toBeNull()
  })
})

describe("sipa pool", () => {
  beforeEach(() => localStorage.clear())

  it("round-trips broadcast entries and reads empty when absent", () => {
    expect(readSipaPool(KEY)).toEqual([])
    appendToSipaPool(KEY, entry({ nonce: 1, published: true }))
    appendToSipaPool(KEY, entry({ nonce: 2, address: OTHER, published: true }))
    expect(readSipaPool(KEY).map((e) => e.nonce)).toEqual([1, 2])
  })

  it("drops malformed and unbroadcast entries instead of failing the read", () => {
    // Pool membership means broadcast: an unpublished entry is not sweepable, and handing one out
    // as if it were invites a deposit nobody sweeps. A malformed one routes funds wrong.
    walletStorage.setItem(
      `${KEY}.pool`,
      JSON.stringify([
        entry({ nonce: 1, published: true }),
        entry({ nonce: 2, published: false }),
        { address: ADDR, day: DAY, published: true },
      ]),
    )
    expect(readSipaPool(KEY).map((e) => e.nonce)).toEqual([1])
    walletStorage.setItem(`${KEY}.pool`, "{not json")
    expect(readSipaPool(KEY)).toEqual([])
  })

  it("take pops oldest-first into the slot and removes what it hands out", async () => {
    appendToSipaPool(KEY, entry({ nonce: 1, published: true }))
    appendToSipaPool(KEY, entry({ nonce: 2, address: OTHER, published: true }))
    expect((await takeFromSipaPool(KEY))?.nonce).toBe(1)
    expect(readCachedSipa(KEY)?.nonce).toBe(1)
    // The popped one is gone — a second take must never hand the same address out twice.
    expect((await takeFromSipaPool(KEY))?.nonce).toBe(2)
    expect(readCachedSipa(KEY)?.nonce).toBe(2)
    expect(await takeFromSipaPool(KEY)).toBeNull()
  })

  it("hands out no address when its move from the pool to the slot is not saved", async () => {
    appendToSipaPool(KEY, entry({ nonce: 1, published: true }))
    await walletStorage.flush()
    testWalletDbs().onApply = () => {
      throw new Error("disk")
    }
    await expect(takeFromSipaPool(KEY)).rejects.toThrow("disk")
    testWalletDbs().onApply = undefined
    // Neither side moved: the pool keeps the entry and the slot stays empty.
    expect(readSipaPool(KEY).map((e) => e.nonce)).toEqual([1])
    expect(readCachedSipa(KEY)).toBeNull()
  })
})

describe("nextSelfSipaNonce", () => {
  it("refuses a nonce whose reservation is not saved", async () => {
    testWalletDbs().onApply = () => {
      throw new Error("disk")
    }
    await expect(nextSelfSipaNonce("scope", DAY)).rejects.toThrow("disk")
    testWalletDbs().onApply = undefined
    expect(await nextSelfSipaNonce("scope", DAY)).toBe(999_999)
  })

  beforeEach(() => localStorage.clear())

  it("counts down from the top of the nonce space, one slot per call", async () => {
    expect(await nextSelfSipaNonce("scope", DAY)).toBe(999_999)
    expect(await nextSelfSipaNonce("scope", DAY)).toBe(999_998)
    expect(await nextSelfSipaNonce("scope", DAY)).toBe(999_997)
  })

  it("restarts at slot 0 when the day rolls and keeps scopes apart", async () => {
    await nextSelfSipaNonce("scope", DAY)
    expect(await nextSelfSipaNonce("scope", DAY + 1)).toBe(999_999)
    expect(await nextSelfSipaNonce("other", DAY + 1)).toBe(999_999)
  })

  it("restarts at slot 0 on a corrupt entry", async () => {
    walletStorage.setItem("scope.slot", "{nope")
    expect(await nextSelfSipaNonce("scope", DAY)).toBe(999_999)
  })

  it("takes the chain floor when it is ahead of the local counter, and vice versa", async () => {
    expect(await nextSelfSipaNonce("scope", DAY, 3)).toBe(999_996)
    expect(await nextSelfSipaNonce("scope", DAY, 1)).toBe(999_995)
    walletStorage.setItem("scope.slot", "{nope")
    expect(await nextSelfSipaNonce("scope", DAY, 2)).toBe(999_997)
  })
})

describe("readUnpublishedSlots", () => {
  const PREFIX = "webwallet.sipa.address.sandbox.0xpool.0xacct."
  beforeEach(() => localStorage.clear())

  it("finds every tag's unpublished slot under the prefix and nothing else", () => {
    writeCachedSipa(`${PREFIX}alice`, entry())
    writeCachedSipa(`${PREFIX}bob`, entry({ nonce: 7 }))
    // A tag literally named "pool" is a slot; only the `.pool` suffix marks a pool.
    writeCachedSipa(`${PREFIX}pool`, entry({ nonce: 3 }))
    writeCachedSipa(`${PREFIX}carol`, entry({ published: true }))
    appendToSipaPool(`${PREFIX}alice`, entry({ published: true, nonce: 9 }))
    writeCachedSipa("webwallet.sipa.address.sandbox.0xpool.0xother.alice", entry())
    localStorage.setItem(`${PREFIX}mallory`, "{not json")

    const slots = readUnpublishedSlots(PREFIX).sort((a, b) => a.key.localeCompare(b.key))
    expect(slots.map((s) => s.key)).toEqual([`${PREFIX}alice`, `${PREFIX}bob`, `${PREFIX}pool`])
    expect(slots.map((s) => s.entry.nonce)).toEqual([4242, 7, 3])
  })

  it("keeps a slot whose broadcast was sent but never marked", () => {
    writeCachedSipa(`${PREFIX}alice`, entry({ broadcastTxHash: "0xtx" }))
    expect(readUnpublishedSlots(PREFIX)).toHaveLength(1)
  })

  it("reads empty with nothing stored", () => {
    expect(readUnpublishedSlots(PREFIX)).toEqual([])
  })
})
