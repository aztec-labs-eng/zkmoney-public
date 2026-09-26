/**
 * Golden ticket witness: everything the `golden_ticket` circuit needs to prove that a paylink note of
 * at least `threshold` sits under a recent note-tree root, siloed to a paylink escrow, bound to one
 * L1 owner. The wallet proves it; the account-service verifies it and grants the reduced schedule.
 */
import type { EthAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import { poseidon2HashWithSeparator } from "@aztec/foundation/crypto/poseidon"
import type { NotesFilter, PXE } from "@aztec/pxe/client/lazy"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { getContractClassFromArtifact } from "@aztec/stdlib/contract"
import { computeUniqueNoteHash, siloNoteHash } from "@aztec/stdlib/hash"
import type { NoteDao } from "@aztec/stdlib/note"
import { type ContractName, type ContractService, DEFAULT_CONTRACTS } from "@obsidion/contracts"
import { DOM_SEP__GOLDEN_TICKET } from "@obsidion/core/constants"
import type { ObsidionWallet } from "../../obsidion/ObsidionWallet.js"
import type { PaylinkParams } from "../PaylinkService.js"
import { unpackPaylinkData } from "./paylinkNoteData.js"
import { registerEscrow } from "./paylinkVoucher.js"

/** Both escrows keep the note in their first storage slot. */
export const PAYLINK_NOTE_STORAGE_SLOT = 1n

/**
 * The chain, as this PXE sees it, does not hold the link's note where the witness needs it: not
 * synced yet, pruned, or reorged. Nothing was redeemed; the wallet retries after the next block.
 */
export class GoldenTicketWitnessError extends Error {
  readonly retryable = true
  constructor(message: string) {
    super(message)
    this.name = "GoldenTicketWitnessError"
  }
}

export interface GoldenTicketDeps {
  wallet: ObsidionWallet
  contractService: ContractService
}

/** The circuit's public inputs, in ABI order; `nullifier` is its return value. */
export interface GoldenTicketPublicInputs {
  root: Fr
  blockNumber: number
  threshold: bigint
  token: AztecAddress
  /** Direct then email paylink class ids. */
  classIds: [Fr, Fr]
  owner: EthAddress
}

export interface GoldenTicketWitness {
  /** ABI input map for `noir_js` / `abiEncode`. */
  inputs: Record<string, unknown>
  publicInputs: GoldenTicketPublicInputs
  /** The note's leaf in the note-hash tree; the nullifier derives from it. */
  uniqueNoteHash: Fr
  nullifier: Fr
  /** What the note holds; below `threshold` the proof can only fail. */
  amount: bigint
}

const hex = (f: { toString(): string }) => f.toString()

/** Direct and email paylink class ids from the configured artifacts. */
export async function paylinkClassIds(contractService: ContractService): Promise<[Fr, Fr]> {
  const id = async (name: ContractName) =>
    (await getContractClassFromArtifact(await contractService.getArtifactForContract(name))).id
  return [await id(DEFAULT_CONTRACTS.paylinkDirect), await id(DEFAULT_CONTRACTS.paylinkEmail)]
}

export function goldenTicketNullifier(uniqueNoteHash: Fr): Promise<Fr> {
  return poseidon2HashWithSeparator([uniqueNoteHash], DOM_SEP__GOLDEN_TICKET)
}

/** The proof's public-input vector as bb.js emits it: the public params in order, then the return. */
export function goldenTicketPublicInputVector(p: GoldenTicketPublicInputs, nullifier: Fr): Fr[] {
  return [
    p.root,
    new Fr(p.threshold),
    p.token.toField(),
    p.classIds[0],
    p.classIds[1],
    p.owner.toField(),
    nullifier,
  ]
}

/**
 * The escrow's settled paylink note as the PXE stores it, read through `PXE.debug.getNotes`, the one
 * note-preimage read `@aztec/pxe` 5.2.0 exposes. Upstream marks it debug-only because a note layout
 * is a contract's implementation detail; here the escrow contract and its note layout are
 * wallet-owned, the read runs inside the PXE job queue behind its block sync and the escrow's own
 * `sync_state`, and the `NotesFilter` / `NoteDao` types make a rename at the next repin a build
 * error. An escrow utility returning the same preimage replaces this at the next escrow redeploy,
 * since a new utility changes the class id.
 */
async function readSettledPaylinkNote(
  pxe: PXE,
  escrow: AztecAddress,
): Promise<NoteDao | undefined> {
  const filter: NotesFilter = {
    contractAddress: escrow,
    scopes: [escrow],
    owner: escrow,
    storageSlot: new Fr(PAYLINK_NOTE_STORAGE_SLOT),
  }
  const notes: NoteDao[] = await pxe.debug.getNotes(filter)
  return notes[0]
}

/**
 * Rebuild the escrow in this PXE, read its settled paylink note, and fetch the note's membership
 * path under the block's note-tree root. `blockNumber` defaults to the node's latest block. Throws
 * `GoldenTicketWitnessError` while the chain disagrees with the PXE.
 */
export async function buildGoldenTicketWitness(
  deps: GoldenTicketDeps,
  params: PaylinkParams,
  opts: { threshold: bigint; owner: EthAddress; blockNumber?: number },
): Promise<GoldenTicketWitness> {
  const { instance, keys, artifact } = await registerEscrow(deps, params)
  const escrow = instance.address
  const dao = await readSettledPaylinkNote(deps.wallet.pxe, escrow)
  if (!dao) {
    throw new GoldenTicketWitnessError(
      "The link's note is not in this wallet's view of the chain yet. Try again after the next block.",
    )
  }

  const node = deps.wallet.node
  const blockNumber = opts.blockNumber ?? Number(await node.getBlockNumber())
  const header = (await node.getBlockData(blockNumber as never))?.header
  if (!header) {
    throw new GoldenTicketWitnessError(
      `Block ${blockNumber} is not available from the node. Try again after the next block.`,
    )
  }
  const root = header.state.partial.noteHashTree.root

  const uniqueNoteHash = await computeUniqueNoteHash(
    dao.noteNonce,
    await siloNoteHash(escrow, dao.noteHash),
  )
  const witness = await node.getNoteHashMembershipWitness(blockNumber as never, uniqueNoteHash)
  if (!witness) {
    throw new GoldenTicketWitnessError(
      `The link's note is not under block ${blockNumber}. Try again after the next block.`,
    )
  }

  const classIds = await paylinkClassIds(deps.contractService)
  const classId = (await getContractClassFromArtifact(artifact)).id
  const note = paylinkNoteInput(dao)
  const publicInputs: GoldenTicketPublicInputs = {
    root,
    blockNumber,
    threshold: opts.threshold,
    token: AztecAddress.fromFieldUnsafe(dao.note.items[6]!),
    classIds,
    owner: opts.owner,
  }
  const pk = keys.publicKeys
  const inputs: Record<string, unknown> = {
    root: hex(root),
    threshold: `0x${opts.threshold.toString(16)}`,
    token: { inner: hex(publicInputs.token.toField()) },
    class_ids: classIds.map(hex),
    owner: hex(opts.owner.toField()),
    note,
    randomness: hex(dao.randomness),
    note_nonce: hex(dao.noteNonce),
    witness: {
      leaf_index: `0x${witness.leafIndex.toString(16)}`,
      sibling_path: witness.siblingPath.map(hex),
    },
    public_keys: {
      npk_m_hash: hex(pk.npkMHash),
      ivpk_m: {
        inner: { x: hex(pk.ivpkM.x), y: hex(pk.ivpkM.y), is_infinite: pk.ivpkM.isInfinite },
      },
      ovpk_m_hash: hex(pk.ovpkMHash),
      tpk_m_hash: hex(pk.tpkMHash),
      mspk_m_hash: hex(pk.mspkMHash),
      fbpk_m_hash: hex(pk.fbpkMHash),
    },
    class_id: hex(classId),
  }
  return {
    inputs,
    publicInputs,
    uniqueNoteHash,
    nullifier: await goldenTicketNullifier(uniqueNoteHash),
    amount: unpackPaylinkData(dao.note.items[2]!).amount,
  }
}

/** Packed `PaylinkNote` items in declaration order. */
function paylinkNoteInput(dao: NoteDao) {
  const items = dao.note.items
  if (items.length !== 7) throw new Error(`paylink note packs 7 fields, got ${items.length}`)
  return {
    hash: hex(items[0]!),
    sender_hash: hex(items[1]!),
    data: hex(items[2]!),
    refundable_until: hex(items[3]!),
    oidc_key_registry: { inner: hex(items[4]!) },
    vkey_hash: hex(items[5]!),
    token_address: { inner: hex(items[6]!) },
  }
}
