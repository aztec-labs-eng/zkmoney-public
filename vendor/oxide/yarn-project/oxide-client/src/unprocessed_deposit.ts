import type { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr, type GrumpkinScalar } from '@aztec/aztec.js/fields';
import { ARCHIVE_HEIGHT } from '@aztec/constants';
import type { EthAddress } from '@aztec/foundation/eth-address';
import { createLogger } from '@aztec/foundation/log';
import type { Tuple } from '@aztec/foundation/serialize';

import type { OxidePortalContract } from '@oxide/l1-contracts';
import { computeDepositMessageHash } from '@oxide/oxide-lib/deposit_message_hashing.js';
import { computeUnprocessedDepositRefundAuthMessage } from '@oxide/oxide-lib/refund_auth_message.js';
import { type RefundOwner, deriveRefundOwnerAddress } from '@oxide/oxide-lib/refund_authorization.js';
import type { TeeSigner, UnprocessedDepositRefundFinalizationOutput } from '@oxide/oxide-lib/types.js';
import { generateUnprocessedDepositRefundProof } from '@oxide/refund-proof/index.js';

import type { ArchiveRef } from './archive_ref.js';
import type { ChainDataSource } from './chain_data_source.js';
import { PermanentError } from './errors.js';
import { buildRefundAuthorization } from './refund_signature.js';

const logger = createLogger('oxide-client:unprocessed_deposit');

export async function buildUnprocessedDepositRefundProof(
  portal: OxidePortalContract,
  args: {
    chain: ChainDataSource;
    signer: TeeSigner;
    l2Token: AztecAddress;
    frozenArchive: ArchiveRef;
    executor: EthAddress;
    amount: bigint;
    userPayloadHash: Fr;
    sharedSecretSalt: Fr;
    l2Recipient: RefundOwner;
    l2RecipientMasterNullifierHidingKey: GrumpkinScalar;
    messageLeafIndex: bigint;
  },
): Promise<{ proof: Buffer; finalization: UnprocessedDepositRefundFinalizationOutput; publicInputs: Fr[] }> {
  const l2Recipient: AztecAddress = args.l2Recipient.address;
  const derived = await deriveRefundOwnerAddress(args.l2Recipient);
  if (!derived.equals(l2Recipient)) {
    throw new PermanentError(
      `Refund owner preimage hashes to ${derived}, expected ${l2Recipient}: the public keys, instance or authorization mode do not belong to this account`,
    );
  }

  const frozenTip = args.frozenArchive.checkpointEndBlockHeader;
  const frozenTipHash = await frozenTip.hash();

  logger.info(
    `Building unprocessed-deposit-refund witness for deposit leafIndex=${args.messageLeafIndex}, amount=${args.amount} against frozen archive ${args.frozenArchive.root}`,
  );

  const frozenTipMembershipWitness = await args.chain.getBlockHashMembershipWitness(
    args.frozenArchive.witnessReferenceBlockNumber,
    frozenTipHash,
  );
  if (!frozenTipMembershipWitness) {
    throw new Error(`Frozen tip ${frozenTipHash} is not in archive ${args.frozenArchive.root}`);
  }

  const [l2Portal, rollupVersion] = await Promise.all([portal.getL2Portal(), portal.getRollupVersion()]);
  const portalContext = {
    l1Portal: portal.address,
    l1ChainId: portal.getChainId(),
    l2Portal,
    rollupVersion,
  };
  const messageHash = await computeDepositMessageHash(portalContext, {
    sharedSecretSalt: args.sharedSecretSalt,
    recipient: l2Recipient,
    amount: args.amount,
    messageLeafIndex: new Fr(args.messageLeafIndex),
  });

  const authMessage = await computeUnprocessedDepositRefundAuthMessage(
    messageHash,
    args.executor,
    args.userPayloadHash,
  );
  const auth = await buildRefundAuthorization(args.l2Recipient.authorizer, authMessage);

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
    auth,
  });

  logger.info(`Generating real unprocessed-deposit-refund Noir proof`);
  const { proof, publicInputs } = await generateUnprocessedDepositRefundProof(
    {
      chainId: portal.getChainId(),
      rollupVersion: await portal.getRollupVersion(),
      l2Token: args.l2Token,
      frozenArchiveRoot: args.frozenArchive.root,
      amount: args.amount,
      userPayloadHash: args.userPayloadHash,
      executor: args.executor,
      messageHash: finalization.messageHash,
      messageLeafIndex: new Fr(args.messageLeafIndex),
      frozenTip,
      frozenTipSiblingPath: frozenTipMembershipWitness.siblingPath as Tuple<Fr, typeof ARCHIVE_HEIGHT>,
      l1Portal: portal.address,
      sharedSecretSalt: args.sharedSecretSalt,
      l2Recipient,
      l2RecipientPublicKeys: args.l2Recipient.publicKeys,
      l2RecipientInstance: args.l2Recipient.instance,
      l2RecipientNhkM: args.l2RecipientMasterNullifierHidingKey,
      auth,
    },
    { logger },
  );
  logger.info(`Generated unprocessed-deposit-refund proof (${proof.length} bytes)`);

  return { proof, finalization, publicInputs };
}
