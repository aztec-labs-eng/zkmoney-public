import type { AztecAddress } from '@aztec/aztec.js/addresses';
import type { Contract } from '@aztec/aztec.js/contracts';
import { Fr } from '@aztec/aztec.js/fields';
import { ARCHIVE_HEIGHT, MAX_NOTE_HASH_READ_REQUESTS_PER_CALL } from '@aztec/constants';
import type { EthAddress } from '@aztec/foundation/eth-address';
import { createLogger } from '@aztec/foundation/log';
import type { Tuple } from '@aztec/foundation/serialize';
import type { BlockHash } from '@aztec/stdlib/block';
import { MerkleTreeId, type NullifierMembershipWitness } from '@aztec/stdlib/trees';

import type { OxidePortalContract } from '@oxide/l1-contracts';
import { computeNoteNullifier } from '@oxide/oxide-lib/hash.js';
import { computeFrozenNotesRefundAuthMessage } from '@oxide/oxide-lib/refund_auth_message.js';
import { type RefundOwner, deriveRefundOwnerAddress } from '@oxide/oxide-lib/refund_authorization.js';
import type { FrozenNotesRefundFinalizationOutput, TeeSigner } from '@oxide/oxide-lib/types.js';
import { MAX_FROZEN_NOTES_PER_REFUND } from '@oxide/refund-proof/frozen_notes_refund/types.js';
import { RefundInputNote, generateFrozenNotesRefundProof } from '@oxide/refund-proof/index.js';

import { type ArchiveRef, resolveArchive } from './archive_ref.js';
import type { ChainDataSource } from './chain_data_source.js';
import { PermanentError } from './errors.js';
import { buildRefundAuthorization } from './refund_signature.js';
import {
  type NullificationEffectData,
  type SpendMetadataResolver,
  buildTokenOperation,
  collectAccountingEffects,
} from './token_operations_collector.js';

const logger = createLogger('oxide-client:frozen_notes');

/**
 * Get frozen notes refundable by the `owner`, judged against `archive` (default: the portal's freeze
 * archive, which is only set once the portal is frozen).
 *
 * A note is refundable if:
 * 1) unspent before the freeze
 * 2) present in the frozen archive
 * 3) and not already refunded on L1.
 */
export async function getRefundableFrozenNotes(
  portal: OxidePortalContract,
  contract: Contract,
  chain: ChainDataSource,
  owner: AztecAddress,
  resolveSpendMetadata: SpendMetadataResolver,
  archive?: ArchiveRef,
): Promise<NullificationEffectData[]> {
  let resolvedArchive = archive;
  if (resolvedArchive === undefined) {
    const freezeArchiveRoot = await portal.getFreezeArchive();
    if (freezeArchiveRoot.equals(Fr.ZERO)) {
      throw new Error(
        'Cannot get refundable frozen notes: portal is not frozen (pass an explicit archive to run pre-freeze).',
      );
    }
    resolvedArchive = await resolveArchive(chain, freezeArchiveRoot);
  }
  const anchorBlockHash = await resolvedArchive.checkpointEndBlockHeader.hash();

  const refundable: NullificationEffectData[] = [];
  for (let offset = 0; ; offset += MAX_NOTE_HASH_READ_REQUESTS_PER_CALL) {
    const { offchainEffects } = await contract.methods.enumerate_owned_notes(owner, offset).simulate({ from: owner });
    if (offchainEffects.length === 0) {
      break;
    }

    // Drop 0-amount notes: the refund circuit reserves amount==0 as its padding sentinel.
    const candidates = collectAccountingEffects(contract.address, offchainEffects).nullifiedNotes.filter(
      note => note.amount.toBigInt() !== 0n,
    );

    const nullifiers = await Promise.all(
      candidates.map(async note => {
        const spendMeta = await resolveSpendMetadata(note);
        return computeNoteNullifier(note.provenNoteHash, contract.address, spendMeta.masterNullifierHidingKey);
      }),
    );

    // One batched existence lookup per tree covers the whole page; the L1 refund-set reads run concurrently.
    const [inArchive, spentBeforeFreeze, refundedOnL1] = await Promise.all([
      chain.findLeavesIndexes(
        anchorBlockHash,
        MerkleTreeId.NOTE_HASH_TREE,
        candidates.map(note => note.provenNoteHash),
      ),
      chain.findLeavesIndexes(anchorBlockHash, MerkleTreeId.NULLIFIER_TREE, nullifiers),
      Promise.all(nullifiers.map(nullifier => portal.isRefundNullifierSpent(nullifier))),
    ]);

    for (let i = 0; i < candidates.length; i++) {
      if (inArchive[i] !== undefined && spentBeforeFreeze[i] === undefined && !refundedOnL1[i]) {
        refundable.push(candidates[i]!);
      }
    }

    if (offchainEffects.length < MAX_NOTE_HASH_READ_REQUESTS_PER_CALL) {
      break;
    }
  }
  return refundable;
}

export async function buildFrozenNotesRefundProof(
  portal: OxidePortalContract,
  args: {
    chain: ChainDataSource;
    signer: TeeSigner;
    l2Token: AztecAddress;
    archive: ArchiveRef;
    executor: EthAddress;
    notes: NullificationEffectData[];
    owner: RefundOwner;
    userPayloadHash: Fr;
    resolveSpendMetadata: SpendMetadataResolver;
  },
): Promise<{ proof: Buffer; finalization: FrozenNotesRefundFinalizationOutput; publicInputs: Fr[] }> {
  if (args.notes.length === 0) {
    throw new PermanentError(`Cannot refund an empty set of notes`);
  }
  if (args.notes.some(n => n.amount.toBigInt() === 0n)) {
    throw new PermanentError(`Cannot spend notes with amount 0`);
  }
  if (args.notes.length > MAX_FROZEN_NOTES_PER_REFUND) {
    throw new PermanentError(`Cannot withdraw more than ${MAX_FROZEN_NOTES_PER_REFUND} notes in a single proof`);
  }

  const derived = await deriveRefundOwnerAddress(args.owner);
  if (!derived.equals(args.owner.address)) {
    throw new PermanentError(
      `Refund owner preimage hashes to ${derived}, expected ${args.owner.address}: the public keys, instance or authorization mode do not belong to this account`,
    );
  }

  const amount = args.notes.reduce((sum, n) => sum + n.amount.toBigInt(), 0n);

  const frozenArchiveRoot = args.archive.root;
  logger.info(
    `Building refund spend witness against archive ${frozenArchiveRoot} (${args.notes.length} notes, total ${amount})`,
  );

  const spendMetadata = await Promise.all(args.notes.map(args.resolveSpendMetadata));
  for (const meta of spendMetadata) {
    if (!meta.ownerAddressPreimage.address.equals(args.owner.address)) {
      throw new PermanentError(
        `Note owner ${meta.ownerAddressPreimage.address} does not match the refund owner ${args.owner.address}`,
      );
    }
  }
  const { spentNotes, anchorBlockHeader: frozenTip } = await buildTokenOperation(
    args.chain,
    args.l2Token,
    args.archive.checkpointEndBlockHeader,
    { nullifiedNotes: args.notes, createdNotes: [], squashedTransientNotes: [], withdrawals: [], deposits: [] },
    spendMetadata,
  );
  const frozenTipHash = await frozenTip.hash();

  const noteNullifiers = await Promise.all(
    args.notes.map((note, i) =>
      computeNoteNullifier(note.provenNoteHash, args.l2Token, spendMetadata[i]!.masterNullifierHidingKey),
    ),
  );
  const lowNullifierMembershipWitnesses = await Promise.all(
    noteNullifiers.map(async nullifier => {
      try {
        const witness = await args.chain.getLowNullifierMembershipWitness(frozenTipHash, nullifier);
        if (!witness) {
          throw new Error(`Missing low-nullifier witness for frozen note nullifier ${nullifier}`);
        }
        return witness;
      } catch (error) {
        throw new Error(`Could not compute low-nullifier witness for frozen note nullifier ${nullifier}: ${error}`);
      }
    }),
  );

  const frozenTipMembershipWitness = await args.chain.getBlockHashMembershipWitness(
    args.archive.witnessReferenceBlockNumber,
    frozenTipHash,
  );
  if (!frozenTipMembershipWitness) {
    throw new Error(`Frozen tip ${frozenTipHash} is not in archive ${frozenArchiveRoot}`);
  }

  // The owner authorizes one message for the whole refund. It commits to the unique note hash of every note in input
  // order (settled notes have `provenNoteHash` equal to their unique note hash), the destination and the tip. The TEE
  // and the Noir circuit each recompute the same message and verify this authorization in the mode the owner's
  // address selects.
  const uniqueNoteHashes = args.notes.map(note => note.provenNoteHash);
  const authMessage = await computeFrozenNotesRefundAuthMessage(uniqueNoteHashes, args.executor, args.userPayloadHash);
  const auth = await buildRefundAuthorization(args.owner.authorizer, authMessage);

  const finalization = await args.signer.signFrozenNotesRefundFinalization({
    frozenArchiveRoot,
    notes: spentNotes,
    executor: args.executor,
    userPayloadHash: args.userPayloadHash,
    frozenTip,
    frozenTipMembershipWitness,
    lowNullifierMembershipWitnesses,
    owner: args.owner.address,
    ownerPublicKeys: args.owner.publicKeys,
    ownerInstance: args.owner.instance,
    auth,
  });

  const proofInputNotes = await buildProofInputNotes(
    args.chain,
    args.notes,
    lowNullifierMembershipWitnesses,
    frozenTipHash,
  );

  logger.info(`Generating real refund Noir proof (${spentNotes.length} active notes)`);
  const { proof, publicInputs } = await generateFrozenNotesRefundProof(
    {
      chainId: portal.getChainId(),
      rollupVersion: await portal.getRollupVersion(),
      l1Portal: portal.address,
      l2Token: args.l2Token,
      frozenArchiveRoot,
      amount,
      userPayloadHash: args.userPayloadHash,
      executor: args.executor,
      frozenTip,
      frozenTipSiblingPath: frozenTipMembershipWitness.siblingPath as Tuple<Fr, typeof ARCHIVE_HEIGHT>,
      notes: proofInputNotes,
      owner: args.owner.address,
      ownerPublicKeys: args.owner.publicKeys,
      ownerInstance: args.owner.instance,
      // Every note has the same owner (asserted above). They all share one master nullifier hiding key.
      ownerNhkM: spendMetadata[0]!.masterNullifierHidingKey,
      auth,
    },
    { logger },
  );
  logger.info(`Generated refund proof (${proof.length} bytes)`);

  return { proof, finalization, publicInputs };
}

async function buildProofInputNotes(
  chain: ChainDataSource,
  inputNotes: NullificationEffectData[],
  lowNullifierMembershipWitnesses: NullifierMembershipWitness[],
  frozenTipHash: BlockHash,
): Promise<Tuple<RefundInputNote, typeof MAX_FROZEN_NOTES_PER_REFUND>> {
  const active = await Promise.all(
    inputNotes.map(async (n, i) => {
      const noteMembershipWitness = await chain.getNoteHashMembershipWitness(frozenTipHash, n.provenNoteHash);
      if (!noteMembershipWitness) {
        throw new Error(`Missing note hash membership witness for ${n.provenNoteHash} at block ${frozenTipHash}`);
      }

      const nmw = lowNullifierMembershipWitnesses[i];
      return new RefundInputNote(
        n.amount.toBigInt(),
        n.randomness,
        n.metadataMaybeNoteNonce,
        noteMembershipWitness,
        nmw.leafPreimage,
        nmw.withoutPreimage(),
      );
    }),
  );

  // Reuse a single padding instance for every empty slot — the circuit ignores them since
  // `amount === 0n`.
  const padding = RefundInputNote.padding();
  const padded = [...active, ...Array(MAX_FROZEN_NOTES_PER_REFUND - active.length).fill(padding)];
  return padded as Tuple<RefundInputNote, typeof MAX_FROZEN_NOTES_PER_REFUND>;
}
