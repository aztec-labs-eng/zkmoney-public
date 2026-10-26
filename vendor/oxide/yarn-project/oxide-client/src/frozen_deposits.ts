// Frozen-message refund client helpers: for L1->L2 deposits that were never spent on L2
// before the portal froze, build the TEE-signed finalisation + real Noir proof and submit
// `OxidePortal.refundFrozenDeposits` to refund the locked ERC20 on L1, up to MAX_FROZEN_DEPOSITS_PER_REFUND at a time.
//
// `l1Ops.refundFrozenDeposits` uses `buildFrozenDepositsRefundProof` internally; the build is
// also exported standalone so callers that need to inspect / replay the artifacts across portal
// states (pre-freeze rejection, post-freeze submission, etc.) can split the build step from the
// submission step.
import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr, type GrumpkinScalar } from '@aztec-labs/aztec.js/fields';
import { ARCHIVE_HEIGHT, L1_TO_L2_MSG_TREE_HEIGHT } from '@aztec-labs/constants';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';
import { createLogger } from '@aztec-labs/foundation/log';
import type { Tuple } from '@aztec-labs/foundation/serialize';
import { MembershipWitness } from '@aztec-labs/foundation/trees';

import type { OxidePortalContract } from '@oxide/l1-contracts';
import type { MigrationSignature, RefundOwner } from '@oxide/oxide-lib/migration_signature.js';
import type { FrozenDeposit, FrozenDepositsRefundFinalizationOutput, TeeSigner } from '@oxide/oxide-lib/types.js';
import {
  MAX_FROZEN_DEPOSITS_PER_REFUND,
  RefundInputDeposit,
} from '@oxide/refund-proof/frozen_deposits_refund/types.js';
import { generateFrozenDepositsRefundProof } from '@oxide/refund-proof/index.js';

import type { ArchiveRef } from './archive_ref.js';
import type { ChainDataSource } from './chain_data_source.js';
import { computeDepositRefundNullifier, getFrozenDepositMessageSiblingPath } from './deposit_refund_eligibility.js';
import { PermanentError } from './errors.js';
import { assertRefundOwner } from './sign_migration.js';

const logger = createLogger('oxide-client:frozen_deposits');

/** One frozen deposit to refund. */
export interface FrozenDepositToRefund {
  amount: bigint;
  sharedSecretSalt: Fr;
  messageKey: Fr;
  messageLeafIndex: bigint;
}

/**
 * Builds one refund of `deposits`, all to `l2Recipient`. The refund amount is the sum of the deposit amounts.
 *
 * One refund links its deposits on L1: it pays them in one transaction to one executor payload, and an observer can
 * match the public sum to the deposits. Refund deposits that came from different L1 addresses one at a time to keep
 * them apart.
 */
export async function buildFrozenDepositsRefundProof(
  portal: OxidePortalContract,
  args: {
    chain: ChainDataSource;
    signer: TeeSigner;
    archive: ArchiveRef;
    executor: EthAddress;
    userPayloadHash: Fr;
    l2Recipient: RefundOwner;
    l2RecipientMasterNullifierHidingKey: GrumpkinScalar;
    deposits: FrozenDepositToRefund[];
    migrationSignature: MigrationSignature;
  },
): Promise<{ proof: Buffer; finalization: FrozenDepositsRefundFinalizationOutput; publicInputs: Fr[] }> {
  if (args.deposits.length === 0) {
    throw new PermanentError('A frozen deposit refund needs at least one deposit');
  }
  if (args.deposits.length > MAX_FROZEN_DEPOSITS_PER_REFUND) {
    throw new PermanentError(
      `Cannot refund more than ${MAX_FROZEN_DEPOSITS_PER_REFUND} deposits in a single proof, got ${args.deposits.length}`,
    );
  }
  const l2Recipient: AztecAddress = args.l2Recipient.address;
  await assertRefundOwner(args.l2Recipient);

  const frozenTip = args.archive.checkpointEndBlockHeader;
  const frozenTipHash = await frozenTip.hash();
  const amount = args.deposits.reduce((sum, deposit) => sum + deposit.amount, 0n);

  logger.info(
    `Building frozen-deposits-refund witness for ${args.deposits.length} deposits (leafIndexes=${args.deposits
      .map(deposit => deposit.messageLeafIndex)
      .join(',')}, amount=${amount}) against archive ${args.archive.root}`,
  );

  const portalDomain = await portal.getPortalDomain();
  const teeDeposits: FrozenDeposit[] = [];
  const proofDeposits: RefundInputDeposit[] = [];
  for (const toRefund of args.deposits) {
    // 1. L1->L2 message membership witness at the frozen tip.
    const deposit = {
      messageKey: toRefund.messageKey,
      messageLeafIndex: toRefund.messageLeafIndex,
      sharedSecretSalt: toRefund.sharedSecretSalt,
      amount: toRefund.amount,
      recipient: args.l2Recipient,
      recipientMasterNullifierHidingKey: args.l2RecipientMasterNullifierHidingKey,
    };
    const { siloedNullifier } = await computeDepositRefundNullifier(portalDomain, deposit);
    const msgSiblingPath = await getFrozenDepositMessageSiblingPath(args.chain, frozenTip, deposit);
    const msgSiblingPathTuple = msgSiblingPath.toTuple() as Tuple<Fr, typeof L1_TO_L2_MSG_TREE_HEIGHT>;
    const messageMembershipWitness = new MembershipWitness<typeof L1_TO_L2_MSG_TREE_HEIGHT>(
      L1_TO_L2_MSG_TREE_HEIGHT,
      toRefund.messageLeafIndex,
      msgSiblingPathTuple,
    );

    // 2. The siloed deposit nullifier must not be in the nullifier tree at the frozen tip.
    const lowNullifierMembershipWitness = await args.chain.getLowNullifierMembershipWitness(
      frozenTipHash,
      siloedNullifier,
    );
    if (!lowNullifierMembershipWitness) {
      throw new Error(
        `Could not compute low-nullifier witness for deposit-message nullifier ${siloedNullifier} - the deposit may have already been spent on L2.`,
      );
    }

    teeDeposits.push({
      amount: toRefund.amount,
      sharedSecretSalt: toRefund.sharedSecretSalt,
      messageMembershipWitness,
      lowNullifierMembershipWitness,
    });
    proofDeposits.push(
      new RefundInputDeposit(
        toRefund.amount,
        toRefund.sharedSecretSalt,
        new Fr(toRefund.messageLeafIndex),
        msgSiblingPathTuple,
        lowNullifierMembershipWitness.leafPreimage,
        lowNullifierMembershipWitness.withoutPreimage(),
      ),
    );
  }

  // 3. Frozen tip must be in the freeze archive. The freeze archive is the archive after the frozen tip, so the
  //    witness exists although the chain stopped at that tip.
  const frozenTipMembershipWitness = await args.chain.getBlockHashMembershipWitnessAtArchive(
    { archive: args.archive.root },
    frozenTipHash,
  );
  if (!frozenTipMembershipWitness) {
    throw new Error(`Frozen tip ${frozenTipHash} is not in archive ${args.archive.root}`);
  }

  // 4. TEE attestation. L1 rebuilds the digest from its own storage, so a signature made for
  //    another portal does not verify.
  const finalization = await args.signer.signFrozenDepositsRefundFinalization({
    frozenArchiveRoot: args.archive.root,
    userPayloadHash: args.userPayloadHash,
    executor: args.executor,
    l2Recipient,
    l2RecipientPublicKeys: args.l2Recipient.publicKeys,
    l2RecipientInstance: args.l2Recipient.instance,
    l2RecipientNhkM: args.l2RecipientMasterNullifierHidingKey,
    frozenTip,
    frozenTipMembershipWitness,
    deposits: teeDeposits,
    migrationSignature: args.migrationSignature,
  });

  // 5. Noir proof over the same witness set, with the deposits padded to the circuit's slot count.
  const padded = [
    ...proofDeposits,
    ...Array.from({ length: MAX_FROZEN_DEPOSITS_PER_REFUND - proofDeposits.length }, () =>
      RefundInputDeposit.padding(),
    ),
  ] as Tuple<RefundInputDeposit, typeof MAX_FROZEN_DEPOSITS_PER_REFUND>;
  logger.info(`Generating real frozen-deposits-refund Noir proof`);
  const { proof, publicInputs } = await generateFrozenDepositsRefundProof(
    {
      chainId: portalDomain.l1ChainId,
      rollupVersion: portalDomain.rollupVersion,
      l2Token: portalDomain.l2Token,
      archiveRoot: args.archive.root,
      amount,
      userPayloadHash: args.userPayloadHash,
      executor: args.executor,
      frozenTip,
      frozenTipSiblingPath: frozenTipMembershipWitness.siblingPath as Tuple<Fr, typeof ARCHIVE_HEIGHT>,
      l1Portal: portalDomain.l1Portal,
      l2Recipient,
      l2RecipientPublicKeys: args.l2Recipient.publicKeys,
      l2RecipientInstance: args.l2Recipient.instance,
      l2RecipientNhkM: args.l2RecipientMasterNullifierHidingKey,
      deposits: padded,
      migrationSignature: args.migrationSignature,
    },
    { logger },
  );
  logger.info(`Generated frozen-deposits-refund proof (${proof.length} bytes)`);

  return { proof, finalization, publicInputs };
}
