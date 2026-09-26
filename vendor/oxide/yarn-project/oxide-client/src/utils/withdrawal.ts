import type { AztecAddress } from '@aztec/aztec.js/addresses';
import type { Fr } from '@aztec/aztec.js/fields';
import type { EthAddress } from '@aztec/foundation/eth-address';
import type { BlockHash } from '@aztec/stdlib/block';
import { computeL2ToL1MembershipWitnessFromMessagesInEpoch } from '@aztec/stdlib/messaging';
import type { TxHash, TxReceipt } from '@aztec/stdlib/tx';

import { extractMetadata } from '@oxide/oxide-lib/da_extractors.js';
import type {
  K1NoteSignature,
  SignTokenOperationOutput,
  TokenOperation,
  WithdrawalFinalizationOutput,
} from '@oxide/oxide-lib/types.js';

import { type ArchiveRef, checkpointContainsBlock } from '../archive_ref.js';
import type { ChainDataSource } from '../chain_data_source.js';
import { PermanentError } from '../errors.js';
import { produceArchivedTxEffectsHints } from '../produce_tx_effects_hints.js';
import { fetchPublishedWithdrawals } from '../published_withdrawal.js';
import { fetchSignerApprovalWitness } from '../signer_approval.js';
import type { L1SubmitContext } from '../types.js';

/**
 * Output of an L2 burn: the receipt, the signed `TokenOperation`, and the TEE sign output (whose
 * `withdrawalSignatures[0]` the L1 finalize signs over). Passed to the direct-submit wrappers when
 * the caller still has these artifacts on hand from the burn-side process. A third-party finalizer
 * with only the burn tx hash should use the `*Published` variants instead.
 */
export interface WithdrawInitiation {
  receipt: TxReceipt;
  tokenOperation: TokenOperation;
  signOutput: SignTokenOperationOutput;
}

/**
 * Normalized input shape consumed by {@link computeWithdrawalWitness} / {@link signWithdrawFinalization}.
 * The fields a withdrawal finalisation needs regardless of whether they came from the in-memory
 * {@link WithdrawInitiation} or the on-chain published-withdrawal log.
 */
export interface WithdrawalInputs {
  txHash: TxHash;
  anchorBlockHash: BlockHash;
  withdrawalSignature: K1NoteSignature;
  executor: EthAddress;
  userPayloadHash: Fr;
  amount: bigint;
  proverTip: bigint;
  randomness: Fr;
}

/** Pull the normalized inputs from `initiation.tokenOperation.withdrawals[withdrawalIndex]` and
 *  the matching withdrawal signature at the same index. */
export async function fromInitiation(
  initiation: WithdrawInitiation,
  withdrawalIndex: number,
): Promise<WithdrawalInputs> {
  const withdrawal = initiation.tokenOperation.withdrawals[withdrawalIndex];
  if (!withdrawal) {
    throw new PermanentError(
      `withdrawalIndex ${withdrawalIndex} out of range (operation has ${initiation.tokenOperation.withdrawals.length} withdrawals)`,
    );
  }
  const withdrawalSignature = initiation.signOutput.withdrawalSignatures[withdrawalIndex];
  if (!withdrawalSignature) {
    throw new PermanentError(`No withdrawal signature at index ${withdrawalIndex}`);
  }
  return {
    txHash: initiation.receipt.txHash,
    anchorBlockHash: await initiation.tokenOperation.anchorBlockHeader.hash(),
    withdrawalSignature,
    executor: withdrawal.executor,
    userPayloadHash: withdrawal.userPayloadHash,
    amount: withdrawal.amount,
    proverTip: withdrawal.proverTip,
    randomness: withdrawal.randomness,
  };
}

/** Pull the normalized inputs out of the published-withdrawal log at `withdrawalIndex` on the burn tx. */
export async function fromPublished(
  chain: ChainDataSource,
  txHash: TxHash,
  withdrawalIndex: number,
  l2Portal: AztecAddress,
): Promise<WithdrawalInputs> {
  const { withdrawals, anchorBlockHash } = await fetchPublishedWithdrawals(chain, txHash, l2Portal);
  const entry = withdrawals[withdrawalIndex];
  if (!entry) {
    throw new PermanentError(
      `withdrawalIndex ${withdrawalIndex} out of range (tx ${txHash} has ${withdrawals.length} published withdrawals)`,
    );
  }
  return {
    txHash,
    anchorBlockHash,
    withdrawalSignature: entry.signature,
    executor: entry.executor,
    userPayloadHash: entry.userPayloadHash,
    amount: entry.amount,
    proverTip: entry.proverTip,
    randomness: entry.randomness,
  };
}

/**
 * Compute the L2 -> L1 outbox membership witness for a finalised withdraw burn. One-shot —
 * caller must have already ensured the epoch containing the burn message is proven (the witness
 * is only available after the burn's epoch lands in the rollup's outbox).
 */
export async function computeWithdrawalWitness(args: {
  chain: ChainDataSource;
  /** Hash of the L2 transaction initiating the withdraw. */
  txHash: TxHash;
  /** L2 -> L1 message hash of the withdraw, as `computeWithdrawMessageHash` derives it. */
  messageHash: Fr;
  /** Index of the withdraw message within the burn tx's L2-to-L1 messages; disambiguates duplicates. */
  messageIndexInTx?: number;
}) {
  // The witness is built server-side, from the source's own Outbox, resolving the smallest partial-proof root that
  // covers the tx's checkpoint and the matching `numCheckpointsInEpoch`. `messageIndexInTx` disambiguates a
  // message hash that appears more than once in the tx.
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
 * Compute the outbox membership path a prover claim needs: the burn message proven under the root
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
  /** Index of the withdraw message within the burn tx's L2-to-L1 messages; disambiguates duplicates. */
  messageIndexInTx?: number;
}) {
  const { epochNumber, blockNumber, txIndexInBlock } = await args.chain.getTxReceipt(args.txHash);
  if (epochNumber === undefined || blockNumber === undefined || txIndexInBlock === undefined) {
    throw new Error(`Burn tx ${args.txHash} is not yet included in a block; cannot build the prover claim witness.`);
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
  // Locate the burn in the epoch tree from its block number alone: the checkpoint whose block range covers it
  // gives the checkpoint index, and the offset from that checkpoint's first block gives the block index.
  const checkpointIndex = checkpointsData.findIndex(c => checkpointContainsBlock(c, blockNumber));
  if (checkpointIndex === -1) {
    throw new Error(`Burn block ${blockNumber} not found in any checkpoint of epoch ${epochNumber}.`);
  }
  const checkpoint = checkpointsData[checkpointIndex]!;
  const blockIndex = blockNumber - checkpoint.startBlock;
  const txIndex = txIndexInBlock;

  const claimCount = Number(args.claimProofLength);
  if (checkpointIndex >= claimCount) {
    // Both the freeze checkpoint and the burn's checkpoint are immutable, so this can never become valid.
    throw new PermanentError(
      `Burn block ${blockNumber} is in checkpoint ${checkpoint.checkpointNumber}, past the claimed proof's ` +
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
    // The message's own checkpoint (where the burn landed).
    checkpointNumber: checkpoint.checkpointNumber,
    leafIndex: witness.leafIndex,
    path: witness.siblingPath.toFields(),
  };
}

/**
 * Build the anchor + ancestry-effects witness the TEE needs to sign the withdrawal finalisation,
 * then sign it. The enclave takes the message hash as given and rejects any hash the burn tx did not
 * attest.
 */
export async function signWithdrawFinalization(
  { chain, signer, l2Token }: Pick<L1SubmitContext, 'chain' | 'signer' | 'l2Token'>,
  args: {
    /** Hash of the L2 burn tx; used to look up ancestry-effects hints. */
    txHash: TxHash;
    /** Hash of the burn-side anchor block (operation anchor). */
    anchorBlockHash: BlockHash;
    /** TEE withdrawal signature. */
    withdrawalSignature: K1NoteSignature;
    archive: ArchiveRef;
    /** L2 -> L1 message hash of the withdraw, as `computeWithdrawMessageHash` derives it. */
    messageHash: Fr;
  },
): Promise<WithdrawalFinalizationOutput> {
  const anchorBlockHashMembershipWitness = await chain.getBlockHashMembershipWitness(
    args.archive.witnessReferenceBlockNumber,
    args.anchorBlockHash,
  );
  if (!anchorBlockHashMembershipWitness) {
    throw new Error(`Operation anchor block ${args.anchorBlockHash} is not in archive ${args.archive.root}`);
  }

  const hints = await produceArchivedTxEffectsHints(chain, args.txHash, args.archive);

  // The burn tx's block (hints.txEffectsHints.txBlockHeader) is already authenticated against
  // archive.root by verifyAndDecodeArchivedTxEffects, so the TEE uses its public data tree
  // root directly.
  const burnEffect = await chain.getTxEffect(args.txHash);
  if (!burnEffect) {
    throw new Error(`Burn tx effect not found for hash ${args.txHash}`);
  }
  const creationMetadata = await extractMetadata(burnEffect.data, l2Token);
  const signerApprovalWitness = await fetchSignerApprovalWitness(
    chain,
    l2Token,
    creationMetadata.publicKey(),
    await hints.txEffectsHints.txBlockHeader.hash(),
  );

  return await signer.signWithdrawalFinalization({
    archiveRoot: args.archive.root,
    hints,
    signature: args.withdrawalSignature,
    messageHash: args.messageHash,
    anchorBlockHashMembershipWitness,
    signerApprovalWitness,
  });
}
