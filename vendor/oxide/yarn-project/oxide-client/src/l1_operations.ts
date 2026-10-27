import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import type { Fr, GrumpkinScalar } from '@aztec-labs/aztec.js/fields';

import type {
  ContractWriteResult,
  DepositEvent,
  ExecutorCall,
  OxidePortalContract,
  WriteOptions,
} from '@oxide/l1-contracts';
import { getUserPayloadHash } from '@oxide/oxide-lib/content_hash.js';
import type { MigrationSignature, RefundOwner } from '@oxide/oxide-lib/migration_signature.js';
import { computeRecipientCommitment } from '@oxide/oxide-lib/recipient_commitment.js';
import { toOutboxWithdrawal } from '@oxide/oxide-lib/withdrawal_finalization_data.js';

import { resolveArchive, resolveTxCheckpointArchive } from './archive_ref.js';
import { PermanentError } from './errors.js';
import { type FrozenDepositToRefund, buildFrozenDepositsRefundProof } from './frozen_deposits.js';
import { buildFrozenNotesRefundProof } from './frozen_notes.js';
import type { NullificationEffectData, SpendMetadataResolver } from './token_operations_collector.js';
import type { L1SubmitContext } from './types.js';
import { buildUnprocessedDepositRefundProof } from './unprocessed_deposit.js';
import { computeWithdrawalWitness, resolveWithdrawal, signWithdrawalFinalization } from './utils/withdrawal.js';
import type { WithdrawalInTx } from './withdrawal_in_tx.js';

export type { L1SubmitContext } from './types.js';

export type DepositResult = {
  /** Decoded Deposit event — undefined when `options.waitForReceipt` was not set. */
  event: DepositEvent | undefined;
} & ContractWriteResult;

export async function deposit(
  portal: OxidePortalContract,
  args: {
    recipient: AztecAddress;
    amount: bigint;
    sharedSecretSalt: Fr;
  },
  options: WriteOptions = {},
): Promise<DepositResult> {
  const recipientCommitment = await computeRecipientCommitment(args.sharedSecretSalt, args.recipient);
  return portal.deposit(recipientCommitment, args.amount, options);
}

/**
 * L1 finalize for the withdraw path. `withdrawal` comes from `submit`, from the owner's recovered withdrawals, or from
 * a finalization request; it is verified against its initiation tx. The initiation's checkpoint must already be proven
 * on L1 so the outbox witness is available.
 */
export async function withdraw(
  ctx: L1SubmitContext,
  args: {
    withdrawal: WithdrawalInTx;
    /** Archive the signature anchors. Defaults to the initiation's own checkpoint archive. Pass an explicit root only
     *  to anchor elsewhere — any proven checkpoint whose archive contains the initiation works, and for a frozen portal
     *  the anchor must be at or before the freeze. */
    archiveRoot?: Fr;
    relayerPayload: Buffer;
  },
  options: WriteOptions = {},
): Promise<ContractWriteResult> {
  const resolved = await resolveWithdrawal(ctx, args.withdrawal);
  const archiveRoot = args.archiveRoot ?? (await resolveTxCheckpointArchive(ctx.chain, resolved.txHash));
  const archive = await resolveArchive(ctx.chain, archiveRoot);
  const finalization = await signWithdrawalFinalization(ctx, {
    txHash: resolved.txHash,
    anchorBlockHash: resolved.anchorBlockHash,
    withdrawalSignature: resolved.finalizationData.withdrawalSignature,
    archive,
    messageHash: resolved.messageHash,
  });
  if (await ctx.portal.isWithdrawalSpent(finalization.withdrawalId)) {
    throw new PermanentError(`Withdrawal ${resolved.messageHash} is already finalized`);
  }

  const witness = await computeWithdrawalWitness({
    chain: ctx.chain,
    txHash: resolved.txHash,
    messageHash: resolved.messageHash,
    messageIndexInTx: resolved.messageIndexInTx,
  });
  const content = toOutboxWithdrawal(resolved.finalizationData);
  return await ctx.portal.withdraw(
    content.executor,
    content.userPayloadHash,
    content.amount,
    content.proverTip,
    content.randomness,
    resolved.finalizationData.userPayload,
    args.relayerPayload,
    witness.epochNumber,
    witness.numCheckpointsInEpoch,
    witness.leafIndex,
    witness.siblingPath,
    archive.checkpointNumber,
    finalization.withdrawalId,
    finalization.signature,
    options,
  );
}

export async function refundFrozenNotes(
  ctx: L1SubmitContext,
  args: {
    /** Executor the portal hands the refund to, plus the payloads it runs. */
    executorCall: ExecutorCall;
    /** Note that notes may mix multiple owners as each is validated against its own owner's keys. */
    notesToRefund: NullificationEffectData[];
    owner: RefundOwner;
    resolveSpendMetadata: SpendMetadataResolver;
    migrationSignature: MigrationSignature;
  },
  options: WriteOptions = {},
): Promise<ContractWriteResult> {
  const archive = await resolveArchive(ctx.chain, await ctx.portal.getFreezeArchive());
  const { proof, finalization } = await buildFrozenNotesRefundProof(ctx.portal, {
    chain: ctx.chain,
    signer: ctx.signer,
    archive,
    executor: args.executorCall.executor,
    userPayloadHash: getUserPayloadHash(args.executorCall.userPayload),
    notes: args.notesToRefund,
    owner: args.owner,
    resolveSpendMetadata: args.resolveSpendMetadata,
    migrationSignature: args.migrationSignature,
  });
  const amount = args.notesToRefund.reduce((sum, n) => sum + n.amount.toBigInt(), 0n);
  return await ctx.portal.refundFrozenNotes(
    args.executorCall,
    amount,
    finalization.nullifiers,
    proof,
    finalization.signature,
    options,
  );
}

export async function refundFrozenDeposits(
  ctx: L1SubmitContext,
  args: {
    executorCall: ExecutorCall;
    l2Recipient: RefundOwner;
    l2RecipientMasterNullifierHidingKey: GrumpkinScalar;
    deposits: FrozenDepositToRefund[];
    migrationSignature: MigrationSignature;
  },
  options: WriteOptions = {},
): Promise<ContractWriteResult> {
  const archive = await resolveArchive(ctx.chain, await ctx.portal.getFreezeArchive());
  const { proof, finalization } = await buildFrozenDepositsRefundProof(ctx.portal, {
    chain: ctx.chain,
    signer: ctx.signer,
    archive,
    executor: args.executorCall.executor,
    userPayloadHash: getUserPayloadHash(args.executorCall.userPayload),
    l2Recipient: args.l2Recipient,
    l2RecipientMasterNullifierHidingKey: args.l2RecipientMasterNullifierHidingKey,
    deposits: args.deposits,
    migrationSignature: args.migrationSignature,
  });
  return await ctx.portal.refundFrozenDeposits(
    args.executorCall,
    finalization.amount,
    finalization.nullifiers,
    proof,
    finalization.signature,
    options,
  );
}

export async function refundUnprocessedDeposit(
  ctx: L1SubmitContext,
  args: {
    executorCall: ExecutorCall;
    amount: bigint;
    sharedSecretSalt: Fr;
    l2Recipient: RefundOwner;
    l2RecipientMasterNullifierHidingKey: GrumpkinScalar;
    messageLeafIndex: bigint;
    migrationSignature: MigrationSignature;
  },
  options: WriteOptions = {},
): Promise<ContractWriteResult> {
  const frozenArchive = await resolveArchive(ctx.chain, await ctx.portal.getFreezeArchive());
  const { proof, finalization } = await buildUnprocessedDepositRefundProof(ctx.portal, {
    chain: ctx.chain,
    signer: ctx.signer,
    frozenArchive,
    executor: args.executorCall.executor,
    userPayloadHash: getUserPayloadHash(args.executorCall.userPayload),
    amount: args.amount,
    sharedSecretSalt: args.sharedSecretSalt,
    l2Recipient: args.l2Recipient,
    l2RecipientMasterNullifierHidingKey: args.l2RecipientMasterNullifierHidingKey,
    messageLeafIndex: args.messageLeafIndex,
    migrationSignature: args.migrationSignature,
  });
  return await ctx.portal.refundUnprocessedDeposit(
    args.executorCall,
    args.amount,
    finalization.siloedNullifier,
    finalization.messageHash,
    args.messageLeafIndex,
    proof,
    finalization.signature,
    options,
  );
}
