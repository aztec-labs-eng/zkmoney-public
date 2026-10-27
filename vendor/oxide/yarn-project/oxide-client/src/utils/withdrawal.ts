import type { Fr } from '@aztec-labs/aztec.js/fields';
import type { BlockHash } from '@aztec-labs/stdlib/block';
import { computeL2ToL1MembershipWitnessFromMessagesInEpoch } from '@aztec-labs/stdlib/messaging';
import type { TxHash } from '@aztec-labs/stdlib/tx';

import { extractMetadata } from '@oxide/oxide-lib/da_extractors.js';
import type { K1NoteSignature, WithdrawalFinalizationOutput } from '@oxide/oxide-lib/types.js';

import { type ArchiveRef, checkpointContainsBlock } from '../archive_ref.js';
import type { ChainDataSource } from '../chain_data_source.js';
import { PermanentError } from '../errors.js';
import { produceArchivedTxEffectsHints } from '../produce_tx_effects_hints.js';
import { fetchSignerRegistrationWitness } from '../signer_registration.js';
import type { L1SubmitContext } from '../types.js';
import { type WithdrawalInTx, verifyWithdrawalInTx } from '../withdrawal_in_tx.js';

/**
 * A withdrawal, verified against its initiation tx, with the chain values that {@link computeWithdrawalWitness} and
 * {@link signWithdrawalFinalization} need: the message hash and its position in the tx, and the operation anchor from
 * the tx's DA.
 */
export type ResolvedWithdrawal = WithdrawalInTx & {
  anchorBlockHash: BlockHash;
  messageHash: Fr;
  messageIndexInTx: number;
};

/** What {@link resolveWithdrawal} reads from its context. A client can give the portal identity it knows without an
 *  L1 client. */
export type WithdrawalPortalContext = Pick<L1SubmitContext, 'chain' | 'signer' | 'l2Token'> & {
  portal: Pick<L1SubmitContext['portal'], 'address' | 'getRollupVersion' | 'getChainId'>;
};

/**
 * Resolve a withdrawal (just submitted, recovered by the owner, or received as a finalization request) for its
 * finalization. Verifies the finalization data against the initiation tx and reads the operation anchor from its DA.
 */
export async function resolveWithdrawal(
  ctx: WithdrawalPortalContext,
  withdrawal: WithdrawalInTx,
): Promise<ResolvedWithdrawal> {
  const portalDomain = {
    l2Token: ctx.l2Token,
    l1Portal: ctx.portal.address,
    teeRegistry: ctx.signer.teeRegistry,
    rollupVersion: await ctx.portal.getRollupVersion(),
    l1ChainId: ctx.portal.getChainId(),
  };
  const effect = await ctx.chain.getTxEffect(withdrawal.txHash);
  if (!effect) {
    throw new Error(`Tx effect not found for hash ${withdrawal.txHash}`);
  }
  const { messageHash, messageIndexInTx } = await verifyWithdrawalInTx(
    ctx.chain,
    portalDomain,
    withdrawal,
    effect.data,
  );
  return {
    txHash: withdrawal.txHash,
    finalizationData: withdrawal.finalizationData,
    anchorBlockHash: (await extractMetadata(effect.data, ctx.l2Token)).anchorBlockHash,
    messageHash,
    messageIndexInTx,
  };
}

/**
 * Compute the L2 -> L1 outbox membership witness for a withdraw initiation. One-shot —
 * caller must have already ensured the epoch containing the initiation message is proven (the witness
 * is only available after the initiation's epoch lands in the rollup's outbox).
 */
export async function computeWithdrawalWitness(args: {
  chain: ChainDataSource;
  /** Hash of the L2 transaction initiating the withdraw. */
  txHash: TxHash;
  /** L2 -> L1 message hash of the withdraw, as `computeWithdrawMessageHash` derives it. */
  messageHash: Fr;
  /** Index of the withdraw message within the initiation tx's L2-to-L1 messages, as `verifyWithdrawalInTx` finds it. */
  messageIndexInTx: number;
}) {
  // The witness is built server-side, from the source's own Outbox, resolving the smallest partial-proof root that
  // covers the tx's checkpoint and the matching `numCheckpointsInEpoch`.
  const witness = await args.chain.getL2ToL1MembershipWitness(args.txHash, args.messageHash, args.messageIndexInTx);
  if (!witness) {
    throw new Error(
      'L2 -> L1 membership witness not available — ensure the checkpoint containing the tx is proven before calling withdraw',
    );
  }
  return {
    epochNumber: witness.epochNumber,
    // Partial-proof depth of the root this witness was built against; the Outbox needs it to read
    // the matching root slot.
    numCheckpointsInEpoch: BigInt(witness.numCheckpointsInEpoch),
    leafIndex: witness.leafIndex,
    siblingPath: witness.siblingPath.toFields(),
  };
}

/**
 * Compute the outbox membership path a prover claim needs: the initiation message proven under the root
 * the claimed proof inserted, built over the epoch tree truncated to exactly `claimProofLength`
 * checkpoints (dropped checkpoints re-padded with zeros). The Portal verifies the claim's `path`
 * against that same root, so building at the claimed depth guarantees the path matches the proof's
 * root slot. Returns the message's own epoch/checkpoint/leaf coordinates.
 */
export async function computeProverClaimWitness(args: {
  chain: ChainDataSource;
  txHash: TxHash;
  /** L2 -> L1 message hash of the withdraw, as `computeWithdrawMessageHash` derives it. */
  messageHash: Fr;
  claimProofLength: bigint;
  /** Index of the withdraw message within the initiation tx's L2-to-L1 messages, as `verifyWithdrawalInTx` finds it. */
  messageIndexInTx: number;
}) {
  const { epochNumber, blockNumber, txIndexInBlock } = await args.chain.getTxReceipt(args.txHash);
  if (epochNumber === undefined || blockNumber === undefined || txIndexInBlock === undefined) {
    throw new Error(
      `Initiation tx ${args.txHash} is not yet included in a block; cannot build the prover claim witness.`,
    );
  }
  // The whole epoch's messages are needed to rebuild the tree at exactly `claimProofLength` checkpoints;
  // `getL2ToL1MembershipWitness` only resolves the smallest-covering root, which won't match a deeper claim.
  const [messagesInEpoch, checkpointsData] = await Promise.all([
    args.chain.getL2ToL1Messages(epochNumber),
    args.chain.getCheckpointsData({ epoch: epochNumber }),
  ]);
  if (messagesInEpoch.length === 0) {
    throw new Error(`Epoch ${epochNumber} has no L2 -> L1 messages; cannot build the prover claim witness.`);
  }
  // Locate the initiation in the epoch tree from its block number alone: the checkpoint whose block range covers it
  // gives the checkpoint index, and the offset from that checkpoint's first block gives the block index.
  const checkpointIndex = checkpointsData.findIndex(c => checkpointContainsBlock(c, blockNumber));
  if (checkpointIndex === -1) {
    throw new Error(`Initiation block ${blockNumber} not found in any checkpoint of epoch ${epochNumber}.`);
  }
  const checkpoint = checkpointsData[checkpointIndex]!;
  const blockIndex = blockNumber - checkpoint.startBlock;
  const txIndex = txIndexInBlock;

  const claimCount = Number(args.claimProofLength);
  if (checkpointIndex >= claimCount) {
    // Both the freeze checkpoint and the initiation's checkpoint are immutable, so this can never become valid.
    throw new PermanentError(
      `Initiation block ${blockNumber} is in checkpoint ${checkpoint.checkpointNumber}, past the claimed proof's ` +
        `${claimCount}-checkpoint prefix; the claim's proof does not cover it.`,
    );
  }
  const witness = computeL2ToL1MembershipWitnessFromMessagesInEpoch(
    messagesInEpoch.slice(0, claimCount),
    args.messageHash,
    checkpointIndex,
    blockIndex,
    txIndex,
    args.messageIndexInTx,
  );

  return {
    epochNumber,
    // The message's own checkpoint (where the initiation landed).
    checkpointNumber: checkpoint.checkpointNumber,
    leafIndex: witness.leafIndex,
    path: witness.siblingPath.toFields(),
  };
}

/**
 * Build the anchor + ancestry-effects witness the TEE needs to sign the withdrawal finalisation,
 * then sign it. The enclave takes the message hash as given and rejects any hash the initiation tx did not
 * attest.
 */
export async function signWithdrawalFinalization(
  { chain, signer, l2Token }: Pick<L1SubmitContext, 'chain' | 'signer' | 'l2Token'>,
  args: {
    /** Hash of the L2 initiation tx; used to look up ancestry-effects hints. */
    txHash: TxHash;
    /** Hash of the initiation-side anchor block (operation anchor). */
    anchorBlockHash: BlockHash;
    /** TEE withdrawal signature. */
    withdrawalSignature: K1NoteSignature;
    archive: ArchiveRef;
    /** L2 -> L1 message hash of the withdraw, as `computeWithdrawMessageHash` derives it. */
    messageHash: Fr;
  },
): Promise<WithdrawalFinalizationOutput> {
  const anchorBlockHashMembershipWitness = await chain.getBlockHashMembershipWitnessAtArchive(
    { archive: args.archive.root },
    args.anchorBlockHash,
  );
  if (!anchorBlockHashMembershipWitness) {
    throw new Error(`Operation anchor block ${args.anchorBlockHash} is not in archive ${args.archive.root}`);
  }

  const hints = await produceArchivedTxEffectsHints(chain, args.txHash, args.archive);

  // The initiation tx's block (hints.txEffectsHints.txBlockHeader) is already authenticated against
  // archive.root by verifyAndDecodeArchivedTxEffects, so the TEE uses its L1->L2 tree root directly.
  const initiationEffect = await chain.getTxEffect(args.txHash);
  if (!initiationEffect) {
    throw new Error(`Initiation tx effect not found for hash ${args.txHash}`);
  }
  const creationMetadata = await extractMetadata(initiationEffect.data, l2Token);
  const signerRegistrationWitness = await fetchSignerRegistrationWitness(
    chain,
    signer.teeRegistry,
    creationMetadata,
    hints.txEffectsHints.txBlockHeader,
  );

  return await signer.signWithdrawalFinalization({
    archiveRoot: args.archive.root,
    hints,
    withdrawalSignature: args.withdrawalSignature,
    messageHash: args.messageHash,
    anchorBlockHashMembershipWitness,
    signerRegistrationWitness,
  });
}
