import { describe, it, expect } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import {
  assertPaylinkTerms,
  buildPaylinkNoteView,
  packPaylinkData,
  PAYLINK_TERMS_REFUSAL,
  paylinkSenderHash,
  paylinkTerms,
  unpackPaylinkData,
} from "./paylinkNoteData.js"
import type { RawPaylinkNote } from "./paylinkNoteData.js"

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

  it("accepts Fr and bigint field encodings", () => {
    const amount = 100n
    const from_claimable = 1n
    const until_claimable = 2n
    const packed = packPaylinkData(amount, from_claimable, until_claimable)

    expect(unpackPaylinkData(packed)).toEqual({ amount, from_claimable, until_claimable })
    expect(unpackPaylinkData(packed.toBigInt())).toEqual({
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

describe("paylinkTerms", () => {
  const note: RawPaylinkNote = {
    hash: new Fr(1),
    sender_hash: new Fr(2),
    data: packPaylinkData(1000n, 10n, 100n),
    refundable_until: new Fr(50),
    oidc_key_registry: AztecAddress.fromBigIntUnsafe(3n),
    vkey_hash: new Fr(4),
    token_address: AztecAddress.fromBigIntUnsafe(5n),
  }

  it("matches paylink_note::test_paylink_terms_vector", async () => {
    expect((await paylinkTerms(note)).toString()).toBe(
      "0x2990a2606ec999744beecb7c857e662d4f0e072435c4a898e51e9ecd78761d29",
    )
  })

  it("hashes the sender as paylink_note::test_sender_hash_vector", async () => {
    expect((await paylinkSenderHash(AztecAddress.fromBigIntUnsafe(7n))).toString()).toBe(
      "0x29f0f539ca2b1865fb736203c036100998291b6e1072323a1db5022f0a52b3cc",
    )
  })

  it("refuses a note other than the link's, and passes a link with no terms", async () => {
    const terms = await paylinkTerms(note)
    await expect(assertPaylinkTerms({ terms }, note)).resolves.toBeUndefined()
    await expect(
      assertPaylinkTerms({}, { ...note, data: packPaylinkData(1n, 10n, 100n) }),
    ).resolves.toBeUndefined()
    await expect(
      assertPaylinkTerms({ terms }, { ...note, data: packPaylinkData(1n, 10n, 100n) }),
    ).rejects.toThrow(PAYLINK_TERMS_REFUSAL)
  })
})
