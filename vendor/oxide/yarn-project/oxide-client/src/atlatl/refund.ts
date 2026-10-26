import type { Fr, GrumpkinScalar } from '@aztec-labs/aztec.js/fields';

import { type ExecutorCall, encodeExecutorCall } from '@oxide/l1-contracts';
import { OxidePortalAbi } from '@oxide/l1-contracts/artifacts.js';
import { getUserPayloadHash } from '@oxide/oxide-lib/content_hash.js';
import type { MigrationSignature, RefundOwner } from '@oxide/oxide-lib/migration_signature.js';

import { type Hex, encodeFunctionData } from 'viem';

import { resolveArchive } from '../archive_ref.js';
import { type FrozenDepositToRefund, buildFrozenDepositsRefundProof } from '../frozen_deposits.js';
import { buildFrozenNotesRefundProof } from '../frozen_notes.js';
import type { NullificationEffectData, SpendMetadataResolver } from '../token_operations_collector.js';
import type { L1SubmitContext } from '../types.js';
import { buildUnprocessedDepositRefundProof } from '../unprocessed_deposit.js';

export async function buildRefundFrozenNotesCalldata(
  ctx: L1SubmitContext,
  args: {
    executorCall: ExecutorCall;
    notesToRefund: NullificationEffectData[];
    owner: RefundOwner;
    resolveSpendMetadata: SpendMetadataResolver;
    migrationSignature: MigrationSignature;
  },
): Promise<Hex> {
  const archiveRoot = await ctx.portal.getFreezeArchive();
  const archive = await resolveArchive(ctx.chain, archiveRoot);
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

  const callArgs = {
    ...encodeExecutorCall(args.executorCall),
    amount,
    nullifiers: finalization.nullifiers.map(n => n.toString() as Hex),
    proof: `0x${proof.toString('hex')}` as Hex,
    teeSignature: finalization.signature.toString() as Hex,
  };
  return encodeFunctionData({ abi: OxidePortalAbi, functionName: 'refundFrozenNotes', args: [callArgs] });
}

export async function buildRefundFrozenDepositsCalldata(
  ctx: L1SubmitContext,
  args: {
    executorCall: ExecutorCall;
    l2Recipient: RefundOwner;
    l2RecipientMasterNullifierHidingKey: GrumpkinScalar;
    deposits: FrozenDepositToRefund[];
    migrationSignature: MigrationSignature;
  },
): Promise<Hex> {
  const archiveRoot = await ctx.portal.getFreezeArchive();
  const archive = await resolveArchive(ctx.chain, archiveRoot);
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

  const callArgs = {
    ...encodeExecutorCall(args.executorCall),
    amount: finalization.amount,
    nullifiers: finalization.nullifiers.map(n => n.toString() as Hex),
    proof: `0x${proof.toString('hex')}` as Hex,
    teeSignature: finalization.signature.toString() as Hex,
  };
  return encodeFunctionData({ abi: OxidePortalAbi, functionName: 'refundFrozenDeposits', args: [callArgs] });
}

export async function buildRefundUnprocessedDepositCalldata(
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
): Promise<Hex> {
  const archiveRoot = await ctx.portal.getFreezeArchive();
  const frozenArchive = await resolveArchive(ctx.chain, archiveRoot);
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

  const callArgs = {
    ...encodeExecutorCall(args.executorCall),
    amount: args.amount,
    siloedNullifier: finalization.siloedNullifier.toString() as Hex,
    messageHash: finalization.messageHash.toString() as Hex,
    messageLeafIndex: args.messageLeafIndex,
    proof: `0x${proof.toString('hex')}` as Hex,
    teeSignature: finalization.signature.toString() as Hex,
  };
  return encodeFunctionData({ abi: OxidePortalAbi, functionName: 'refundUnprocessedDeposit', args: [callArgs] });
}
