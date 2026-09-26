/**
 * Pins the packed-AssertedNote → NullificationEffectData mapping (field order + K1 sig layout +
 * SETTLED stage) and the discovery adapter's zero-amount filter / missing-patch guard. The exact
 * `provenNoteHash` value is a real poseidon derivation exercised end-to-end by the migration
 * suite; here we only pin that it is derived (deterministic, owner/nonce/randomness-sensitive).
 */
import { describe, it, expect } from "vitest"
import { Fr } from "@aztec/aztec.js/fields"
import { AztecAddress } from "@aztec/aztec.js/addresses"
import { TxHash } from "@aztec/stdlib/tx"
import type { NoteDao } from "@aztec/stdlib/note"
import {
  noteDaoToNullificationEffect,
  discoverPaylinkEscrowNotes,
} from "./paylinkEscrowNotes.js"

// Minimal NoteDao stand-in — only the fields the mapper reads. `note.items` is the packed
// AssertedNote: [amount, randomness, s_lo, s_hi, r_lo, r_hi].
function fakeDao(items: Fr[], owner: AztecAddress, opts?: Partial<NoteDao>): NoteDao {
  return {
    note: { items },
    owner,
    storageSlot: new Fr(7),
    noteNonce: new Fr(99),
    noteHash: new Fr(555),
    txHash: TxHash.fromField(new Fr(123)),
    ...opts,
  } as unknown as NoteDao
}

describe("noteDaoToNullificationEffect", () => {
  it("maps packed items + metadata into the effect (sig order, settled stage)", async () => {
    const owner = await AztecAddress.random()
    const token = await AztecAddress.random()
    const items = [new Fr(1_000n), new Fr(2), new Fr(11), new Fr(12), new Fr(13), new Fr(14)]

    const eff = await noteDaoToNullificationEffect(fakeDao(items, owner), token)

    expect(eff.amount.toBigInt()).toBe(1_000n)
    expect(eff.randomness.toBigInt()).toBe(2n)
    expect(eff.owner.equals(owner)).toBe(true)
    expect(eff.storageSlot.toBigInt()).toBe(7n)
    expect(eff.metadataMaybeNoteNonce.toBigInt()).toBe(99n)
    expect(eff.metadataStage).toBe(3)
    expect(eff.signature.sLo.toBigInt()).toBe(11n)
    expect(eff.signature.sHi.toBigInt()).toBe(12n)
    expect(eff.signature.rLo.toBigInt()).toBe(13n)
    expect(eff.signature.rHi.toBigInt()).toBe(14n)
    expect(eff.provenNoteHash).toBeInstanceOf(Fr)
    expect(eff.provenNoteHash.isZero()).toBe(false)
  })

  it("derives provenNoteHash deterministically and sensitive to the note nonce", async () => {
    const owner = await AztecAddress.random()
    const token = await AztecAddress.random()
    const items = [new Fr(5n), new Fr(6), new Fr(0), new Fr(0), new Fr(0), new Fr(0)]

    const a = await noteDaoToNullificationEffect(fakeDao(items, owner), token)
    const b = await noteDaoToNullificationEffect(fakeDao(items, owner), token)
    const c = await noteDaoToNullificationEffect(
      fakeDao(items, owner, { noteNonce: new Fr(100) }),
      token,
    )
    expect(a.provenNoteHash.equals(b.provenNoteHash)).toBe(true)
    expect(a.provenNoteHash.equals(c.provenNoteHash)).toBe(false)
  })

  it("rejects a note with too few packed fields", async () => {
    const owner = await AztecAddress.random()
    const token = await AztecAddress.random()
    await expect(
      noteDaoToNullificationEffect(fakeDao([new Fr(1), new Fr(2)], owner), token),
    ).rejects.toThrow(/expected >=6 packed/)
  })
})

describe("discoverPaylinkEscrowNotes", () => {
  const items = (amount: bigint) => [
    new Fr(amount),
    new Fr(2),
    new Fr(11),
    new Fr(12),
    new Fr(13),
    new Fr(14),
  ]

  it("throws a descriptive error when the PXE isn't patched", async () => {
    const paylink = await AztecAddress.random()
    const token = await AztecAddress.random()
    await expect(
      discoverPaylinkEscrowNotes({ pxe: {}, tokenAddress: token, paylinkAddress: paylink, scopes: [paylink] }),
    ).rejects.toThrow(/syncContractNotes\(\) is missing/)
  })

  it("keeps only paylink-owned, non-zero-amount notes", async () => {
    const paylink = await AztecAddress.random()
    const other = await AztecAddress.random()
    const token = await AztecAddress.random()
    const pxe = {
      syncContractNotes: async () => [
        fakeDao(items(300_000n), paylink),
        fakeDao(items(0n), paylink), // spent → dropped
        fakeDao(items(500n), other), // wrong owner → dropped
      ],
    }

    const notes = await discoverPaylinkEscrowNotes({
      pxe,
      tokenAddress: token,
      paylinkAddress: paylink,
      scopes: [paylink],
    })
    expect(notes.length).toBe(1)
    expect(notes[0].amount.toBigInt()).toBe(300_000n)
    expect(notes[0].owner.equals(paylink)).toBe(true)
  })
})
