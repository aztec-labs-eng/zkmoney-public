import { describe, it, expect } from "vitest"
import { Fr } from "@aztec/aztec.js/fields"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { buildPaylinkNoteView, unpackPaylinkData } from "./paylinkNoteData.js"
import type { RawPaylinkNote } from "./paylinkNoteData.js"

/** Test-only mirror of `paylink_note::pack_data` for round-trip checks. */
function packPaylinkData(amount: bigint, from_claimable: bigint, until_claimable: bigint): Fr {
  const amountBytes = new Fr(amount).toBuffer()
  const fromBytes = new Fr(from_claimable).toBuffer()
  const untilBytes = new Fr(until_claimable).toBuffer()

  const combined = Buffer.alloc(32)
  for (let i = 0; i < 16; i++) combined[i] = amountBytes[16 + i]!
  for (let i = 0; i < 8; i++) combined[16 + i] = fromBytes[24 + i]!
  for (let i = 0; i < 8; i++) combined[24 + i] = untilBytes[24 + i]!

  let result = 0n
  for (let i = 0; i < 32; i++) {
    result = result * 256n + BigInt(combined[i]!)
  }
  return new Fr(result)
}

function rawNote(data: Fr, refundable_until: Fr = Fr.ZERO): RawPaylinkNote {
  return {
    hash: Fr.ZERO,
    sender_hash: Fr.ZERO,
    data,
    refundable_until,
    oidc_key_registry: AztecAddress.ZERO,
    vkey_hash: Fr.ZERO,
    token_address: AztecAddress.fromBigIntUnsafe(42n),
  }
}

describe("unpackPaylinkData", () => {
  it("matches paylink_note::test_pack_unpack_timestamp_like_values", () => {
    const amount = 1_000_000_000_000_000_000n
    const from_claimable = 1_704_067_200n
    const until_claimable = 1_735_689_600n

    const packed = packPaylinkData(amount, from_claimable, until_claimable)
    expect(unpackPaylinkData(packed)).toEqual({ amount, from_claimable, until_claimable })
  })

  it("accepts Fr and string field encodings", () => {
    const amount = 100n
    const from_claimable = 1n
    const until_claimable = 2n
    const packed = packPaylinkData(amount, from_claimable, until_claimable)

    expect(unpackPaylinkData(packed)).toEqual({ amount, from_claimable, until_claimable })
    expect(unpackPaylinkData(packed.toString())).toEqual({
      amount,
      from_claimable,
      until_claimable,
    })
  })
})

describe("buildPaylinkNoteView refund window", () => {
  const packed = packPaylinkData(500n, 1_000n, 2_000n)
  const note = rawNote(packed, new Fr(1_500n))

  it("exposes refundableUntil", () => {
    expect(buildPaylinkNoteView(note, 1_100).refundableUntil).toBe(1_500)
  })

  it("refundable from creation while still claimable, boundary inclusive", () => {
    expect(buildPaylinkNoteView(note, 500).isRefundable).toBe(true)
    const view = buildPaylinkNoteView(note, 1_300)
    expect(view.isClaimable).toBe(true)
    expect(view.isRefundable).toBe(true)
    expect(buildPaylinkNoteView(note, 1_500).isRefundable).toBe(true)
  })

  it("not refundable between refundableUntil and claimableUntil", () => {
    expect(buildPaylinkNoteView(note, 1_501).isRefundable).toBe(false)
    expect(buildPaylinkNoteView(note, 2_000).isRefundable).toBe(false)
  })

  it("refundable again after expiry", () => {
    expect(buildPaylinkNoteView(note, 2_001).isRefundable).toBe(true)
  })

  it("zero refundableUntil is refundable only after expiry", () => {
    expect(buildPaylinkNoteView(rawNote(packed), 1_300).isRefundable).toBe(false)
    expect(buildPaylinkNoteView(rawNote(packed), 2_001).isRefundable).toBe(true)
  })
})

describe("buildPaylinkNoteView", () => {
  const amount = 500n
  const from = 1_000n
  const until = 2_000n
  const packed = packPaylinkData(amount, from, until)
  const note = rawNote(packed)

  it("exposes amount, validUntil, expiresAt, and tokenAddress", () => {
    const view = buildPaylinkNoteView(note, 1_500)
    expect(view.amount).toBe(amount)
    expect(view.tokenAddress.toString()).toBe(note.token_address.toString())
    expect(view.claimableFrom).toBe(1_000)
    expect(view.claimableUntil).toBe(2_000)
    expect(view.expiresAt).toBe(2_000)
    expect(view.validUntil).toBe(new Date(2_000_000).toISOString())
  })

  it("gracePeriod before claimableFrom", () => {
    const view = buildPaylinkNoteView(note, 999)
    expect(view.status).toBe("gracePeriod")
    expect(view.isInGracePeriod).toBe(true)
    expect(view.isClaimable).toBe(false)
    expect(view.isExpired).toBe(false)
  })

  it("claimable within the window", () => {
    const view = buildPaylinkNoteView(note, 1_500)
    expect(view.status).toBe("claimable")
    expect(view.isClaimable).toBe(true)
    expect(view.isInGracePeriod).toBe(false)
    expect(view.isExpired).toBe(false)
  })

  it("expired after claimableUntil", () => {
    const view = buildPaylinkNoteView(note, 2_001)
    expect(view.status).toBe("expired")
    expect(view.isExpired).toBe(true)
    expect(view.isClaimable).toBe(false)
  })

  it("claimable at claimableFrom boundary", () => {
    const view = buildPaylinkNoteView(note, 1_000)
    expect(view.status).toBe("claimable")
    expect(view.isClaimable).toBe(true)
  })

  it("not expired exactly at claimableUntil", () => {
    const view = buildPaylinkNoteView(note, 2_000)
    expect(view.isExpired).toBe(false)
    expect(view.isClaimable).toBe(true)
  })
})
