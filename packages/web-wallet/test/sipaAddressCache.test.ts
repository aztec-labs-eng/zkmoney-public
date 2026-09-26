/**
 * The SIPA address cache decides which L1 address a sender is told to fund, and a wrong answer is
 * only visible once someone has already paid an address nobody sweeps. These are the three pieces
 * that carry that decision: what a stored entry is worth today, whether a stored entry is
 * trustworthy at all, and whether two derivations can be mistaken for one another.
 */
import { beforeEach, describe, expect, it } from "vitest"
import type { Address } from "viem"
import {
  appendToSipaPool,
  decideSipaCache,
  nextSelfSipaNonce,
  publishKey,
  readCachedSipa,
  readSipaPool,
  takeFromSipaPool,
  writeCachedSipa,
} from "../src/features/deposit/sipaGateway"

const KEY = "webwallet.sipa.address.sandbox.0xpool.0xacct.alice"
const ADDR = `0x${"ab".repeat(20)}` as Address
const DAY = 20662

const entry = (over: Partial<Parameters<typeof writeCachedSipa>[1]> = {}) => ({
  address: ADDR,
  day: DAY,
  nonce: 4242,
  published: false,
  ...over,
})

describe("decideSipaCache", () => {
  it("derives when there is no entry", () => {
    expect(decideSipaCache(null, false)).toBe("derive")
  })

  it("derives when the caller asked for a fresh address, published or not", () => {
    expect(decideSipaCache(entry({ published: true }), true)).toBe("derive")
    expect(decideSipaCache(entry(), true)).toBe("derive")
  })

  it("never hands out a published address twice", () => {
    // Each address is single-use: reusing one links every sender who pays this wallet.
    expect(decideSipaCache(entry({ published: true }), false)).toBe("derive")
    expect(decideSipaCache(entry({ published: true, day: DAY - 9 }), false)).toBe("derive")
  })

  it("finishes publishing an unpublished entry, whatever day it came from", () => {
    // Abandoning it would strand anything a sender already paid into it; `(day, nonce)`
    // regenerate the derivation exactly, so age is irrelevant.
    expect(decideSipaCache(entry(), false)).toBe("republish")
    expect(decideSipaCache(entry({ day: DAY - 1 }), false)).toBe("republish")
  })
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
    localStorage.setItem(KEY, JSON.stringify({ address: ADDR, day: DAY, published: false }))
    expect(readCachedSipa(KEY)).toBeNull()
  })

  it("rejects a non-integer nonce or day", () => {
    localStorage.setItem(KEY, JSON.stringify(entry({ nonce: 1.5 })))
    expect(readCachedSipa(KEY)).toBeNull()
    localStorage.setItem(KEY, JSON.stringify(entry({ day: "20662" as unknown as number })))
    expect(readCachedSipa(KEY)).toBeNull()
  })

  it("rejects a non-boolean published flag", () => {
    localStorage.setItem(KEY, JSON.stringify(entry({ published: 1 as unknown as boolean })))
    expect(readCachedSipa(KEY)).toBeNull()
  })

  it("rejects a missing address", () => {
    localStorage.setItem(KEY, JSON.stringify({ day: DAY, nonce: 4242, published: true }))
    expect(readCachedSipa(KEY)).toBeNull()
  })

  it("fails soft on corrupt JSON", () => {
    localStorage.setItem(KEY, "{not json")
    expect(readCachedSipa(KEY)).toBeNull()
  })
})

describe("sipa pool", () => {
  beforeEach(() => localStorage.clear())

  it("round-trips broadcast entries and reads empty when absent", () => {
    expect(readSipaPool(KEY)).toEqual([])
    appendToSipaPool(KEY, entry({ nonce: 1, published: true }))
    appendToSipaPool(KEY, entry({ nonce: 2, published: true }))
    expect(readSipaPool(KEY).map((e) => e.nonce)).toEqual([1, 2])
  })

  it("drops malformed and unbroadcast entries instead of failing the read", () => {
    // Pool membership means broadcast: an unpublished entry is not sweepable, and handing one out
    // as if it were invites a deposit nobody sweeps. A malformed one routes funds wrong.
    localStorage.setItem(
      `${KEY}.pool`,
      JSON.stringify([
        entry({ nonce: 1, published: true }),
        entry({ nonce: 2, published: false }),
        { address: ADDR, day: DAY, published: true },
      ]),
    )
    expect(readSipaPool(KEY).map((e) => e.nonce)).toEqual([1])
    localStorage.setItem(`${KEY}.pool`, "{not json")
    expect(readSipaPool(KEY)).toEqual([])
  })

  it("take pops oldest-first and removes what it hands out", () => {
    appendToSipaPool(KEY, entry({ nonce: 1, published: true }))
    appendToSipaPool(KEY, entry({ nonce: 2, published: true }))
    expect(takeFromSipaPool(KEY)?.nonce).toBe(1)
    // The popped one is gone — a second take must never hand the same address out twice.
    expect(takeFromSipaPool(KEY)?.nonce).toBe(2)
    expect(takeFromSipaPool(KEY)).toBeNull()
  })
})

describe("publishKey", () => {
  it("is stable for the same derivation", () => {
    expect(publishKey(KEY, entry())).toBe(publishKey(KEY, entry()))
  })

  it("separates derivations that differ in nonce or day", () => {
    // This is what stops a `fresh` address from adopting the in-flight publish of the address it
    // replaced — the case where the screen shows one address while another is broadcast.
    expect(publishKey(KEY, entry({ nonce: 1 }))).not.toBe(publishKey(KEY, entry({ nonce: 2 })))
    expect(publishKey(KEY, entry({ day: DAY }))).not.toBe(publishKey(KEY, entry({ day: DAY + 1 })))
  })

  it("separates accounts and deployments through the cache key", () => {
    expect(publishKey(KEY, entry())).not.toBe(publishKey(`${KEY}.other`, entry()))
  })
})

describe("nextSelfSipaNonce", () => {
  beforeEach(() => localStorage.clear())

  it("counts down from the top of the nonce space, one slot per call", () => {
    expect(nextSelfSipaNonce("scope", DAY)).toBe(999_999)
    expect(nextSelfSipaNonce("scope", DAY)).toBe(999_998)
    expect(nextSelfSipaNonce("scope", DAY)).toBe(999_997)
  })

  it("restarts at slot 0 when the day rolls and keeps scopes apart", () => {
    nextSelfSipaNonce("scope", DAY)
    expect(nextSelfSipaNonce("scope", DAY + 1)).toBe(999_999)
    expect(nextSelfSipaNonce("other", DAY + 1)).toBe(999_999)
  })

  it("restarts at slot 0 on a corrupt entry", () => {
    localStorage.setItem("scope.slot", "{nope")
    expect(nextSelfSipaNonce("scope", DAY)).toBe(999_999)
  })

  it("takes the chain floor when it is ahead of the local counter, and vice versa", () => {
    expect(nextSelfSipaNonce("scope", DAY, 3)).toBe(999_996)
    expect(nextSelfSipaNonce("scope", DAY, 1)).toBe(999_995)
    localStorage.setItem("scope.slot", "{nope")
    expect(nextSelfSipaNonce("scope", DAY, 2)).toBe(999_997)
  })
})
