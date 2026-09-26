import type { AztecAddress } from '@aztec/aztec.js/addresses';
import type { Fr, GrumpkinScalar } from '@aztec/aztec.js/fields';
import type { TxHash } from '@aztec/stdlib/tx';

import type {
  ContractWriteResult,
  DepositEvent,
  ExecutorCall,
  OxidePortalContract,
  WriteOptions,
} from '@oxide/l1-contracts';
import { getUserPayloadHash } from '@oxide/oxide-lib/content_hash.js';
import { computeWithdrawMessageHash } from '@oxide/oxide-lib/hash.js';
import { computeRecipientCommitment } from '@oxide/oxide-lib/recipient_commitment.js';
import type { RefundOwner } from '@oxide/oxide-lib/refund_authorization.js';

import { resolveArchive, resolveBurnCheckpointArchive } from './archive_ref.js';
import { buildFrozenDepositRefundProof } from './frozen_deposit.js';
import { buildFrozenNotesRefundProof } from './frozen_notes.js';
import type { NullificationEffectData, SpendMetadataResolver } from './token_operations_collector.js';
import type { L1SubmitContext } from './types.js';
import { buildUnprocessedDepositRefundProof } from './unprocessed_deposit.js';
import {
  type WithdrawInitiation,
  type WithdrawalInputs,
  computeWithdrawalWitness,
  fromInitiation,
  fromPublished,
  signWithdrawFinalization,
} from './utils/withdrawal.js';

export type { L1SubmitContext } from './types.js';
export type { WithdrawInitiation } from './utils/withdrawal.js';

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
 * L1 finalize for the withdraw path. The burn's checkpoint must
 * already be proven on L1 so the outbox witness is available.
 */
export async function withdraw(
  ctx: L1SubmitContext,
  args: {
    initiation: WithdrawInitiation;
    /** Archive the signature anchors. Defaults to the burn's own checkpoint archive. Pass an explicit root only to
     *  anchor elsewhere — any proven checkpoint whose archive contains the burn works, and for a frozen portal the
     *  anchor must be at or before the freeze. */
    archiveRoot?: Fr;
    /** Index of the withdrawal to finalize within `initiation.tokenOperation.withdrawals`. A burn tx may emit
     *  multiple withdrawals; the caller must pick one explicitly. */
    withdrawalIndex: number;
    userPayload: Buffer;
    relayerPayload: Buffer;
  },
  options: WriteOptions = {},
): Promise<ContractWriteResult> {
  return await submitWithdrawal(
    ctx,
    {
      ...(await fromInitiation(args.initiation, args.withdrawalIndex)),
      archiveRoot: args.archiveRoot,
      userPayload: args.userPayload,
      relayerPayload: args.relayerPayload,
    },
    options,
  );
}

/**
 * L1 finalize for the withdraw path, when the caller only has the burn tx hash. The burn tx's epoch must already be
 * proven on L1 so the outbox witness is available.
 */
export async function withdrawPublished(
  ctx: L1SubmitContext,
  args: {
    /** Hash of the L2 transaction that published and burned the withdrawal. */
    txHash: TxHash;
    /** Archive the signature anchors. Defaults to the burn's own checkpoint archive. Pass an explicit root only to
     *  anchor elsewhere — any proven checkpoint whose archive contains the burn works, and for a frozen portal the
     *  anchor must be at or before the freeze. */
    archiveRoot?: Fr;
    /** Index of the published withdrawal entry to finalize. A burn tx may emit multiple
     *  withdrawals; the caller must pick one explicitly. */
    withdrawalIndex: number;
    userPayload: Buffer;
    relayerPayload: Buffer;
  },
  options: WriteOptions = {},
): Promise<ContractWriteResult> {
  return await submitWithdrawal(
    ctx,
    {
      ...(await fromPublished(ctx.chain, args.txHash, args.withdrawalIndex, ctx.l2Token)),
      archiveRoot: args.archiveRoot,
      userPayload: args.userPayload,
      relayerPayload: args.relayerPayload,
    },
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
  },
  options: WriteOptions = {},
): Promise<ContractWriteResult> {
  const archive = await resolveArchive(ctx.chain, await ctx.portal.getFreezeArchive());
  const { proof, finalization } = await buildFrozenNotesRefundProof(ctx.portal, {
    chain: ctx.chain,
    signer: ctx.signer,
    l2Token: ctx.l2Token,
    archive,
    executor: args.executorCall.executor,
    userPayloadHash: getUserPayloadHash(args.executorCall.userPayload),
    notes: args.notesToRefund,
    owner: args.owner,
    resolveSpendMetadata: args.resolveSpendMetadata,
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

export async function refundFrozenDeposit(
  ctx: L1SubmitContext,
  args: {
    executorCall: ExecutorCall;
    amount: bigint;
    sharedSecretSalt: Fr;
    l2Recipient: RefundOwner;
    l2RecipientMasterNullifierHidingKey: GrumpkinScalar;
    messageKey: Fr;
    messageLeafIndex: bigint;
  },
  options: WriteOptions = {},
): Promise<ContractWriteResult> {
  const archive = await resolveArchive(ctx.chain, await ctx.portal.getFreezeArchive());
  const { proof, finalization } = await buildFrozenDepositRefundProof(ctx.portal, {
    chain: ctx.chain,
    signer: ctx.signer,
    l2Token: ctx.l2Token,
    archive,
    executor: args.executorCall.executor,
    userPayloadHash: getUserPayloadHash(args.executorCall.userPayload),
    amount: args.amount,
    sharedSecretSalt: args.sharedSecretSalt,
    l2Recipient: args.l2Recipient,
    l2RecipientMasterNullifierHidingKey: args.l2RecipientMasterNullifierHidingKey,
    messageKey: args.messageKey,
    messageLeafIndex: args.messageLeafIndex,
  });
  return await ctx.portal.refundFrozenDeposit(
    args.executorCall,
    args.amount,
    finalization.siloedNullifier,
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
    inboxSiblingPath: Fr[];
  },
  options: WriteOptions = {},
): Promise<ContractWriteResult> {
  const frozenArchive = await resolveArchive(ctx.chain, await ctx.portal.getFreezeArchive());
  const { proof, finalization } = await buildUnprocessedDepositRefundProof(ctx.portal, {
    chain: ctx.chain,
    signer: ctx.signer,
    l2Token: ctx.l2Token,
    frozenArchive,
    executor: args.executorCall.executor,
    userPayloadHash: getUserPayloadHash(args.executorCall.userPayload),
    amount: args.amount,
    sharedSecretSalt: args.sharedSecretSalt,
    l2Recipient: args.l2Recipient,
    l2RecipientMasterNullifierHidingKey: args.l2RecipientMasterNullifierHidingKey,
    messageLeafIndex: args.messageLeafIndex,
  });
  return await ctx.portal.refundUnprocessedDeposit(
    args.executorCall,
    args.amount,
    finalization.siloedNullifier,
    finalization.messageHash,
    args.messageLeafIndex,
    args.inboxSiblingPath,
    proof,
    finalization.signature,
    options,
  );
}

/**
 * Workhorse for `withdraw` / `withdrawPublished`. Resolves the archive, computes the L2->L1 outbox
 * membership witness, signs the finalisation, and submits `OxidePortal.withdraw`.
 */
async function submitWithdrawal(
  ctx: L1SubmitContext,
  args: WithdrawalInputs & { archiveRoot?: Fr; userPayload: Buffer; relayerPayload: Buffer },
  options: WriteOptions,
): Promise<ContractWriteResult> {
  const archiveRoot = args.archiveRoot ?? (await resolveBurnCheckpointArchive(ctx.chain, args.txHash));
  const archive = await resolveArchive(ctx.chain, archiveRoot);
  const messageHash = computeWithdrawMessageHash(
    {
      l2Portal: ctx.l2Token,
      l1Portal: ctx.portal.address,
      rollupVersion: await ctx.portal.getRollupVersion(),
      l1ChainId: ctx.portal.getChainId(),
    },
    args,
  );
  const finalization = await signWithdrawFinalization(ctx, {
    txHash: args.txHash,
    anchorBlockHash: args.anchorBlockHash,
    withdrawalSignature: args.withdrawalSignature,
    archive,
    messageHash,
  });

  const witness = await computeWithdrawalWitness({
    chain: ctx.chain,
    txHash: args.txHash,
    messageHash,
  });
  return await ctx.portal.withdraw(
    args.executor,
    args.userPayloadHash,
    args.amount,
    args.proverTip,
    args.randomness,
    args.userPayload,
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
