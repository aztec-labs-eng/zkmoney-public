/**
 * Discover an unclaimed paylink's escrowed OxideToken note straight from the PXE note store,
 * and reconstruct the `NullificationEffectData` the frozen-notes exit proof consumes — WITHOUT
 * simulating a spend.
 *
 * Why not simulate a spend? The account-shaped enumeration (`getRefundableFrozenNotes`) discovers
 * notes by simulating `token.withdraw(owner)`, which needs an account entrypoint the paylink
 * contract doesn't have. Simulating the paylink's own `claim()` doesn't generalise either — email
 * paylinks can't be claimed at migration time (no registry / JWK / zkJWT). So we read the stored
 * note directly: every field of a `NullificationEffectData` is recoverable from the persisted
 * `AssertedNote` plus its PXE metadata.
 *
 * Packed AssertedNote layout (`asserted_note.nr`: `{ amount, randomness, signature }`, signature =
 * `{ s_lo, s_hi, r_lo, r_hi }`), so `NoteDao.note.items` is:
 *   [0] amount  [1] randomness  [2] s_lo  [3] s_hi  [4] r_lo  [5] r_hi
 * The K1 signature rides inline in the note, so it comes back for free once the note is synced.
 */
import { Fr } from "@aztec/aztec.js/fields"
import type { AztecAddress } from "@aztec/aztec.js/addresses"
import type { NoteDao } from "@aztec/stdlib/note"
import { computeUniqueNoteHash, siloNoteHash } from "@aztec/stdlib/hash"
import type { NullificationEffectData } from "@oxide/oxide-client/token_operations_collector.js"

// Mirror of aztec-nr `NoteStage::SETTLED` — any note read out of the note store lives in the tree.
const NOTE_STAGE_SETTLED = 3

/** Minimal view of the patched PXE surface this adapter needs (see `patches/@aztec__pxe@4.3.0.patch`). */
export interface SyncContractNotesPxe {
  syncContractNotes?: (
    contractAddress: AztecAddress,
    scopes: AztecAddress[],
    filter?: { owner?: AztecAddress; storageSlot?: Fr },
  ) => Promise<NoteDao[]>
}

/**
 * Reconstruct a `NullificationEffectData` from a stored AssertedNote `NoteDao`.
 *
 * `provenNoteHash` (the unique note hash) is the DAO's inner `noteHash` siloed by the token
 * contract and made unique with the note nonce; `metadataStage` is `SETTLED`; the K1 signature is
 * read straight out of the packed note items. `creationTxHash` is the note's origin tx — the
 * paylink spend-metadata resolver overrides it anyway, and the exit proof path never squashes
 * settled notes, so it is not load-bearing here.
 */
export async function noteDaoToNullificationEffect(
  dao: NoteDao,
  tokenAddress: AztecAddress,
): Promise<NullificationEffectData> {
  const items = dao.note.items
  if (items.length < 6) {
    throw new Error(
      `noteDaoToNullificationEffect: expected >=6 packed AssertedNote fields, got ${items.length}`,
    )
  }
  const amount = items[0]
  const randomness = items[1]

  const siloedNoteHash = await siloNoteHash(tokenAddress, dao.noteHash)
  const provenNoteHash = await computeUniqueNoteHash(dao.noteNonce, siloedNoteHash)

  return {
    amount,
    owner: dao.owner,
    randomness,
    storageSlot: dao.storageSlot,
    provenNoteHash,
    metadataStage: NOTE_STAGE_SETTLED,
    metadataMaybeNoteNonce: dao.noteNonce,
    // Wire order matches Noir `Signature { s_lo, s_hi, r_lo, r_hi }`.
    signature: { sLo: items[2], sHi: items[3], rLo: items[4], rHi: items[5] },
    creationTxHash: dao.txHash,
  }
}

/**
 * Discover the escrow note(s) an unclaimed paylink holds in the OxideToken, as
 * `NullificationEffectData[]` ready for a frozen-notes refund of the escrow.
 *
 * The paylink contract (instance + keys) MUST be registered in the PXE before calling — an
 * unregistered owner syncs and returns zero notes with no error. `scopes` must include the
 * paylink address so its notes decrypt under a known scope.
 */
export async function discoverPaylinkEscrowNotes(args: {
  pxe: SyncContractNotesPxe
  tokenAddress: AztecAddress
  paylinkAddress: AztecAddress
  scopes: AztecAddress[]
}): Promise<NullificationEffectData[]> {
  if (typeof args.pxe.syncContractNotes !== "function") {
    throw new Error(
      "PXE.syncContractNotes() is missing — apply patches/@aztec__pxe@4.3.0.patch (on-demand " +
        "contract note sync). An unpatched @aztec/pxe returns undefined here, not an error.",
    )
  }

  const daos = await args.pxe.syncContractNotes(args.tokenAddress, args.scopes, {
    owner: args.paylinkAddress,
  })

  const escrow = daos.filter((d) => d.owner.equals(args.paylinkAddress))
  const notes = await Promise.all(
    escrow.map((d) => noteDaoToNullificationEffect(d, args.tokenAddress)),
  )
  // A fully-claimed/spent escrow has no active notes; a zero-amount note can't be exited.
  return notes.filter((n) => n.amount.toBigInt() > 0n)
}
