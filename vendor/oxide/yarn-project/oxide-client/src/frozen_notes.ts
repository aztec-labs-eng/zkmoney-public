import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import type { Contract, SimulateInteractionOptions } from '@aztec-labs/aztec.js/contracts';
import type { Fr } from '@aztec-labs/aztec.js/fields';
import { ARCHIVE_HEIGHT, MAX_NOTE_HASH_READ_REQUESTS_PER_CALL } from '@aztec-labs/constants';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';
import { createLogger } from '@aztec-labs/foundation/log';
import type { Tuple } from '@aztec-labs/foundation/serialize';
import type { BlockHash } from '@aztec-labs/stdlib/block';
import { MerkleTreeId, type NullifierMembershipWitness } from '@aztec-labs/stdlib/trees';

import type { OxidePortalContract } from '@oxide/l1-contracts';
import { computeNoteNullifier } from '@oxide/oxide-lib/hash.js';
import type { MigrationSignature, RefundOwner } from '@oxide/oxide-lib/migration_signature.js';
import type { FrozenNotesRefundFinalizationOutput, TeeSigner } from '@oxide/oxide-lib/types.js';
import { MAX_FROZEN_NOTES_PER_REFUND } from '@oxide/refund-proof/frozen_notes_refund/types.js';
import { RefundInputNote, generateFrozenNotesRefundProof } from '@oxide/refund-proof/index.js';

import { type ArchiveRef, resolveFreezeArchive } from './archive_ref.js';
import type { ChainDataSource } from './chain_data_source.js';
import { PermanentError } from './errors.js';
import { assertRefundOwner } from './sign_migration.js';
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
 *
 * The notes are enumerated by simulating as `owner`. An owner with no account entrypoint, such as an escrow, passes
 * `simulateOptions` that reach its notes, e.g. `{ from: NO_FROM, additionalScopes: [owner] }`.
 */
export async function getRefundableFrozenNotes(
  portal: OxidePortalContract,
  contract: Contract,
  chain: ChainDataSource,
  owner: AztecAddress,
  resolveSpendMetadata: SpendMetadataResolver,
  archive?: ArchiveRef,
  simulateOptions: SimulateInteractionOptions = { from: owner },
): Promise<NullificationEffectData[]> {
  const resolvedArchive = archive ?? (await resolveFreezeArchive(portal, chain));
  const anchorBlockHash = await resolvedArchive.checkpointEndBlockHeader.hash();

  const refundable: NullificationEffectData[] = [];
  for (let offset = 0; ; offset += MAX_NOTE_HASH_READ_REQUESTS_PER_CALL) {
    const { offchainEffects } = await contract.methods.enumerate_owned_notes(owner, offset).simulate(simulateOptions);
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
    archive: ArchiveRef;
    executor: EthAddress;
    notes: NullificationEffectData[];
    owner: RefundOwner;
    userPayloadHash: Fr;
    resolveSpendMetadata: SpendMetadataResolver;
    /** The owner's migration signature. It must cover this refund (see `signMigration`). */
    migrationSignature: MigrationSignature;
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

  const portalDomain = await portal.getPortalDomain();

  await assertRefundOwner(args.owner);

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
    portalDomain.l2Token,
    portalDomain.teeRegistry,
    args.archive.checkpointEndBlockHeader,
    { nullifiedNotes: args.notes, createdNotes: [], squashedTransientNotes: [], withdrawals: [], deposits: [] },
    spendMetadata,
  );
  const frozenTipHash = await frozenTip.hash();

  const noteNullifiers = await Promise.all(
    args.notes.map((note, i) =>
      computeNoteNullifier(note.provenNoteHash, portalDomain.l2Token, spendMetadata[i]!.masterNullifierHidingKey),
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

  const frozenTipMembershipWitness = await args.chain.getBlockHashMembershipWitnessAtArchive(
    { archive: args.archive.root },
    frozenTipHash,
  );
  if (!frozenTipMembershipWitness) {
    throw new Error(`Frozen tip ${frozenTipHash} is not in archive ${frozenArchiveRoot}`);
  }

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
    migrationSignature: args.migrationSignature,
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
      chainId: portalDomain.l1ChainId,
      rollupVersion: portalDomain.rollupVersion,
      l1Portal: portalDomain.l1Portal,
      l2Token: portalDomain.l2Token,
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
      migrationSignature: args.migrationSignature,
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
