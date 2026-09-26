import { describe, it, expect } from "vitest"
import { Fr } from "@aztec/aztec.js/fields"
import { DEFAULT_CONTRACTS } from "@obsidion/contracts"
import { deriveDeterministicPaylinkKeys, derivePaylinkKeys } from "./paylinkKeys.js"

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
    const otherCreator = await deriveDeterministicPaylinkKeys(new Fr(MSK.toBigInt() + 1n), DAY, N, DIRECT)
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
    await expect(deriveDeterministicPaylinkKeys(MSK, DAY, N, DEFAULT_CONTRACTS.claimFpc)).rejects.toThrow(
      /unsupported paylink flavor/,
    )
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
