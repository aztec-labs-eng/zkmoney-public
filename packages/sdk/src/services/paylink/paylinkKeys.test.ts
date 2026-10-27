import { describe, it, expect } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { DEFAULT_CONTRACTS } from "@obsidion/contracts"
import {
  deriveDeterministicPaylinkKeys,
  deriveLegacyPaylinkKeys,
  derivePaylinkKeys,
  deriveSlotPaylinkKeys,
  findPaylinkKeysForDay,
} from "./paylinkKeys.js"
import { Buffer } from "buffer"
import {
  LINK_SEED_BYTES,
  LinkKind,
  linkKeyFromSecret,
  linkSecret,
} from "../linkLocator/linkLocator.js"

// pnpm test src/services/paylink/paylinkKeys.test.ts

const MSK = Fr.fromString("0x1f2e3d4c5b6a798807162534435261708f9eadbccbdaeaf9081726354453627a")
const DAY = 20671
const N = 0
const DIRECT = DEFAULT_CONTRACTS.paylinkDirect
const EMAIL = DEFAULT_CONTRACTS.paylinkEmail

describe("deriveDeterministicPaylinkKeys", () => {
  it("is a pure function of (masterSecret, day, n, flavor)", async () => {
    const a = await deriveDeterministicPaylinkKeys(MSK, DAY, N, DIRECT)
    const b = await deriveDeterministicPaylinkKeys(MSK, DAY, N, DIRECT)

    expect(a.secretKey.toString()).toBe(b.secretKey.toString())
    expect(a.fallbackSecret!.toString()).toBe(b.fallbackSecret!.toString())
    expect(a.publicKeys.equals(b.publicKeys)).toBe(true)
  })

  it("gives every paylink its own secrets", async () => {
    const base = await deriveDeterministicPaylinkKeys(MSK, DAY, N, DIRECT)
    const nextSlot = await deriveDeterministicPaylinkKeys(MSK, DAY, N + 1, DIRECT)
    const nextDay = await deriveDeterministicPaylinkKeys(MSK, DAY + 1, N, DIRECT)
    const otherCreator = await deriveDeterministicPaylinkKeys(
      new Fr(MSK.toBigInt() + 1n),
      DAY,
      N,
      DIRECT,
    )
    const otherFlavor = await deriveDeterministicPaylinkKeys(MSK, DAY, N, EMAIL)

    for (const other of [nextSlot, nextDay, otherCreator, otherFlavor]) {
      expect(other.secretKey.toString()).not.toBe(base.secretKey.toString())
      expect(other.fallbackSecret!.toString()).not.toBe(base.fallbackSecret!.toString())
    }
  })

  it("rejects a day that isn't an epoch-day index", async () => {
    for (const bad of [Date.now(), Math.floor(Date.now() / 1000), 6082026, -1, 1.5]) {
      await expect(deriveDeterministicPaylinkKeys(MSK, bad, N, DIRECT)).rejects.toThrow(/epoch-day/)
    }
  })

  it("rejects a non-paylink flavor", async () => {
    await expect(
      deriveDeterministicPaylinkKeys(MSK, DAY, N, DEFAULT_CONTRACTS.claimFpc),
    ).rejects.toThrow(/unsupported paylink flavor/)
  })

  // A shared separator would hand the migration factor to anyone holding the link.
  it("separates the secret from the fallback secret", async () => {
    const { secretKey, fallbackSecret } = await deriveDeterministicPaylinkKeys(MSK, DAY, N, DIRECT)
    expect(secretKey.toString()).not.toBe(fallbackSecret!.toString())
  })
})

describe("derivePaylinkKeys", () => {
  // The link carries the secret and the fallback point; a claimer must land on the creator's escrow
  // from those alone, and never on the fallback secret.
  it("lands a link holder on the creator's keys without the fallback secret", async () => {
    const created = await deriveDeterministicPaylinkKeys(MSK, DAY, N, DIRECT)
    const fromLink = await derivePaylinkKeys({
      secretKey: created.secretKey,
      fallbackKeyHash: created.fallbackKeyHash,
    })
    expect(fromLink.publicKeys.equals(created.publicKeys)).toBe(true)
    expect(fromLink.fallbackSecret).toBeUndefined()
  })
})

describe("short link seeds", () => {
  it("derives a slot's secret from its link key's seed", async () => {
    const keys = await deriveDeterministicPaylinkKeys(MSK, DAY, N, DIRECT)
    expect(keys.link!.seed).toHaveLength(LINK_SEED_BYTES)
    expect(keys.link!.seed).toEqual(linkKeyFromSecret(keys.link!.secretKey).seed)
    expect((await linkSecret(LinkKind.Paylink, keys.link!.seed)).equals(keys.secretKey)).toBe(true)
  })

  it("gives each slot its own link key", async () => {
    const [a, b] = await Promise.all([
      deriveDeterministicPaylinkKeys(MSK, DAY, N, DIRECT),
      deriveDeterministicPaylinkKeys(MSK, DAY, N + 1, DIRECT),
    ])
    expect(Buffer.from(a.link!.secretKey).equals(Buffer.from(b.link!.secretKey))).toBe(false)
  })

  it("keeps the fallback secret off the seed", async () => {
    const seeded = await deriveDeterministicPaylinkKeys(MSK, DAY, N, DIRECT)
    const legacy = await deriveLegacyPaylinkKeys(MSK, DAY, N, DIRECT)
    expect(seeded.secretKey.equals(legacy.secretKey)).toBe(false)
    expect(seeded.fallbackSecret!.equals(legacy.fallbackSecret!)).toBe(true)
  })

  it("finds a slot's keys from either derivation's secret", async () => {
    for (const derive of [deriveDeterministicPaylinkKeys, deriveLegacyPaylinkKeys]) {
      const created = await derive(MSK, DAY, 5, EMAIL)
      const found = await findPaylinkKeysForDay(MSK, DAY, created.secretKey, EMAIL)
      expect(found?.publicKeys.equals(created.publicKeys)).toBe(true)
      expect(found?.nonce).toEqual({ day: DAY, n: 5 })
    }
  })

  it("lists both escrows a slot can hold", async () => {
    const [seeded, legacy] = await deriveSlotPaylinkKeys(MSK, DAY, N, DIRECT)
    expect(seeded!.link).toBeDefined()
    expect(legacy!.link).toBeUndefined()
  })
})
