import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr, type GrumpkinScalar } from '@aztec-labs/aztec.js/fields';
import { ARCHIVE_HEIGHT } from '@aztec-labs/constants';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';
import { createLogger } from '@aztec-labs/foundation/log';
import type { Tuple } from '@aztec-labs/foundation/serialize';

import type { OxidePortalContract } from '@oxide/l1-contracts';
import type { MigrationSignature, RefundOwner } from '@oxide/oxide-lib/migration_signature.js';
import type { TeeSigner, UnprocessedDepositRefundFinalizationOutput } from '@oxide/oxide-lib/types.js';
import { generateUnprocessedDepositRefundProof } from '@oxide/refund-proof/index.js';

import type { ArchiveRef } from './archive_ref.js';
import type { ChainDataSource } from './chain_data_source.js';
import { isAbsorbedAtFrozenTip } from './deposit_refund_eligibility.js';
import { PermanentError } from './errors.js';
import { assertRefundOwner } from './sign_migration.js';

const logger = createLogger('oxide-client:unprocessed_deposit');

export async function buildUnprocessedDepositRefundProof(
  portal: OxidePortalContract,
  args: {
    chain: ChainDataSource;
    signer: TeeSigner;
    frozenArchive: ArchiveRef;
    executor: EthAddress;
    amount: bigint;
    userPayloadHash: Fr;
    sharedSecretSalt: Fr;
    l2Recipient: RefundOwner;
    l2RecipientMasterNullifierHidingKey: GrumpkinScalar;
    messageLeafIndex: bigint;
    migrationSignature: MigrationSignature;
  },
): Promise<{ proof: Buffer; finalization: UnprocessedDepositRefundFinalizationOutput; publicInputs: Fr[] }> {
  const l2Recipient: AztecAddress = args.l2Recipient.address;
  await assertRefundOwner(args.l2Recipient);

  const frozenTip = args.frozenArchive.checkpointEndBlockHeader;
  if (isAbsorbedAtFrozenTip(frozenTip, args.messageLeafIndex)) {
    throw new PermanentError(
      `The frozen tip absorbed the deposit message at leaf index ${args.messageLeafIndex}, so it is not an unprocessed deposit`,
    );
  }
  const frozenTipHash = await frozenTip.hash();

  logger.info(
    `Building unprocessed-deposit-refund witness for deposit leafIndex=${args.messageLeafIndex}, amount=${args.amount} against frozen archive ${args.frozenArchive.root}`,
  );

  const frozenTipMembershipWitness = await args.chain.getBlockHashMembershipWitnessAtArchive(
    { archive: args.frozenArchive.root },
    frozenTipHash,
  );
  if (!frozenTipMembershipWitness) {
    throw new Error(`Frozen tip ${frozenTipHash} is not in archive ${args.frozenArchive.root}`);
  }

  const portalDomain = await portal.getPortalDomain();

  const { migrationSignature } = args;

  const finalization = await args.signer.signUnprocessedDepositRefundFinalization({
    frozenArchiveRoot: args.frozenArchive.root,
    amount: args.amount,
    userPayloadHash: args.userPayloadHash,
    executor: args.executor,
    sharedSecretSalt: args.sharedSecretSalt,
    l2Recipient,
    l2RecipientPublicKeys: args.l2Recipient.publicKeys,
    l2RecipientInstance: args.l2Recipient.instance,
    l2RecipientNhkM: args.l2RecipientMasterNullifierHidingKey,
    messageLeafIndex: new Fr(args.messageLeafIndex),
    frozenTip,
    frozenTipMembershipWitness,
    migrationSignature,
  });

  logger.info(`Generating real unprocessed-deposit-refund Noir proof`);
  const { proof, publicInputs } = await generateUnprocessedDepositRefundProof(
    {
      chainId: portalDomain.l1ChainId,
      rollupVersion: portalDomain.rollupVersion,
      l2Token: portalDomain.l2Token,
      frozenArchiveRoot: args.frozenArchive.root,
      amount: args.amount,
      userPayloadHash: args.userPayloadHash,
      executor: args.executor,
      messageHash: finalization.messageHash,
      messageLeafIndex: new Fr(args.messageLeafIndex),
      frozenTip,
      frozenTipSiblingPath: frozenTipMembershipWitness.siblingPath as Tuple<Fr, typeof ARCHIVE_HEIGHT>,
      l1Portal: portalDomain.l1Portal,
      sharedSecretSalt: args.sharedSecretSalt,
      l2Recipient,
      l2RecipientPublicKeys: args.l2Recipient.publicKeys,
      l2RecipientInstance: args.l2Recipient.instance,
      l2RecipientNhkM: args.l2RecipientMasterNullifierHidingKey,
      migrationSignature,
    },
    { logger },
  );
  logger.info(`Generated unprocessed-deposit-refund proof (${proof.length} bytes)`);

  return { proof, finalization, publicInputs };
}
