// Frozen-message refund client helpers: for an L1->L2 deposit that was never spent on L2
// before the portal froze, build the TEE-signed finalisation + real Noir proof and submit
// `OxidePortal.refundFrozenDeposit` to refund the locked ERC20 on L1.
//
// `l1Ops.refundFrozenDeposit` uses `buildFrozenDepositRefundProof` internally; the build is
// also exported standalone so callers that need to inspect / replay the artifacts across portal
// states (pre-freeze rejection, post-freeze submission, etc.) can split the build step from the
// submission step.
import type { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr, type GrumpkinScalar } from '@aztec/aztec.js/fields';
import { ARCHIVE_HEIGHT, L1_TO_L2_MSG_TREE_HEIGHT } from '@aztec/constants';
import type { EthAddress } from '@aztec/foundation/eth-address';
import { createLogger } from '@aztec/foundation/log';
import type { Tuple } from '@aztec/foundation/serialize';
import { MembershipWitness } from '@aztec/foundation/trees';

import type { OxidePortalContract } from '@oxide/l1-contracts';
import {
  computeDepositMessageHash,
  computeSiloedDepositMessageNullifier,
} from '@oxide/oxide-lib/deposit_message_hashing.js';
import { computeFrozenDepositRefundAuthMessage } from '@oxide/oxide-lib/refund_auth_message.js';
import { type RefundOwner, deriveRefundOwnerAddress } from '@oxide/oxide-lib/refund_authorization.js';
import type { FrozenDepositRefundFinalizationOutput, TeeSigner } from '@oxide/oxide-lib/types.js';
import { generateFrozenDepositRefundProof } from '@oxide/refund-proof/index.js';

import type { ArchiveRef } from './archive_ref.js';
import type { ChainDataSource } from './chain_data_source.js';
import { PermanentError } from './errors.js';
import { buildRefundAuthorization } from './refund_signature.js';

const logger = createLogger('oxide-client:frozen_deposit');

export async function buildFrozenDepositRefundProof(
  portal: OxidePortalContract,
  args: {
    chain: ChainDataSource;
    signer: TeeSigner;
    l2Token: AztecAddress;
    archive: ArchiveRef;
    executor: EthAddress;
    amount: bigint;
    userPayloadHash: Fr;
    sharedSecretSalt: Fr;
    l2Recipient: RefundOwner;
    l2RecipientMasterNullifierHidingKey: GrumpkinScalar;
    messageKey: Fr;
    messageLeafIndex: bigint;
  },
): Promise<{ proof: Buffer; finalization: FrozenDepositRefundFinalizationOutput; publicInputs: Fr[] }> {
  const l2Recipient: AztecAddress = args.l2Recipient.address;
  const derived = await deriveRefundOwnerAddress(args.l2Recipient);
  if (!derived.equals(l2Recipient)) {
    throw new PermanentError(
      `Refund owner preimage hashes to ${derived}, expected ${l2Recipient}: the public keys, instance or authorization mode do not belong to this account`,
    );
  }

  const frozenTip = args.archive.checkpointEndBlockHeader;
  const frozenTipHash = await frozenTip.hash();

  logger.info(
    `Building frozen-deposit-refund witness for deposit messageKey=${args.messageKey}, leafIndex=${args.messageLeafIndex}, amount=${args.amount} against archive ${args.archive.root}`,
  );

  // 1. L1->L2 message membership witness at the frozen tip.
  const msgWitness = await args.chain.getL1ToL2MessageMembershipWitness(frozenTipHash, args.messageKey);
  if (!msgWitness) {
    throw new Error(`No L1->L2 membership witness for deposit message ${args.messageKey} at ${frozenTipHash}`);
  }
  const [witnessLeafIndex, msgSiblingPath] = msgWitness;
  if (witnessLeafIndex !== args.messageLeafIndex) {
    throw new PermanentError(
      `Deposit witness leaf index ${witnessLeafIndex} does not match event leaf index ${args.messageLeafIndex}`,
    );
  }
  const msgSiblingPathTuple = msgSiblingPath.toTuple() as Tuple<Fr, typeof L1_TO_L2_MSG_TREE_HEIGHT>;
  const messageMembershipWitness = new MembershipWitness<typeof L1_TO_L2_MSG_TREE_HEIGHT>(
    L1_TO_L2_MSG_TREE_HEIGHT,
    args.messageLeafIndex,
    msgSiblingPathTuple,
  );

  const [l2Portal, rollupVersion] = await Promise.all([portal.getL2Portal(), portal.getRollupVersion()]);
  const messageHash = await computeDepositMessageHash(
    {
      l1Portal: portal.address,
      l1ChainId: portal.getChainId(),
      l2Portal,
      rollupVersion,
    },
    {
      sharedSecretSalt: args.sharedSecretSalt,
      recipient: l2Recipient,
      amount: args.amount,
      messageLeafIndex: new Fr(args.messageLeafIndex),
    },
  );
  const siloedNullifier = await computeSiloedDepositMessageNullifier(
    l2Portal,
    messageHash,
    args.l2RecipientMasterNullifierHidingKey,
  );
  const lowNullifierMembershipWitness = await args.chain.getLowNullifierMembershipWitness(
    frozenTipHash,
    siloedNullifier,
  );
  if (!lowNullifierMembershipWitness) {
    throw new Error(
      `Could not compute low-nullifier witness for deposit-message nullifier ${siloedNullifier} - the deposit may have already been spent on L2.`,
    );
  }

  // 3. Frozen tip must be in the freeze archive.
  const frozenTipMembershipWitness = await args.chain.getBlockHashMembershipWitness(
    args.archive.witnessReferenceBlockNumber,
    frozenTipHash,
  );
  if (!frozenTipMembershipWitness) {
    throw new Error(`Frozen tip ${frozenTipHash} is not in archive ${args.archive.root}`);
  }

  // 4. Authorization by the L2 recipient. The TEE and the Noir circuit each recompute the same `messageHash` and the
  //    same auth message, then verify this authorization in the mode the recipient's address selects. Without the
  //    passkey (or the master fallback key), knowledge of the deposit transcript alone is not enough to mint a refund
  //    proof.
  const authMessage = await computeFrozenDepositRefundAuthMessage(messageHash, args.executor, args.userPayloadHash);
  const auth = await buildRefundAuthorization(args.l2Recipient.authorizer, authMessage);

  // 5. TEE attestation. The signer rebinds {l1Portal, l2Portal, chainId, rollupVersion} from its
  //    bound portal context, so the digest is implicitly bound to the right portal.
  const finalization = await args.signer.signFrozenDepositRefundFinalization({
    frozenArchiveRoot: args.archive.root,
    amount: args.amount,
    userPayloadHash: args.userPayloadHash,
    executor: args.executor,
    sharedSecretSalt: args.sharedSecretSalt,
    l2Recipient,
    l2RecipientPublicKeys: args.l2Recipient.publicKeys,
    l2RecipientInstance: args.l2Recipient.instance,
    l2RecipientNhkM: args.l2RecipientMasterNullifierHidingKey,
    frozenTip,
    frozenTipMembershipWitness,
    messageMembershipWitness,
    lowNullifierMembershipWitness,
    auth,
  });

  // 6. Noir proof over the same witness set.
  logger.info(`Generating real frozen-deposit-refund Noir proof`);
  const { proof, publicInputs } = await generateFrozenDepositRefundProof(
    {
      chainId: portal.getChainId(),
      rollupVersion: await portal.getRollupVersion(),
      l2Token: args.l2Token,
      archiveRoot: args.archive.root,
      amount: args.amount,
      userPayloadHash: args.userPayloadHash,
      executor: args.executor,
      frozenTip,
      frozenTipSiblingPath: frozenTipMembershipWitness.siblingPath as Tuple<Fr, typeof ARCHIVE_HEIGHT>,
      l1Portal: portal.address,
      sharedSecretSalt: args.sharedSecretSalt,
      l2Recipient,
      l2RecipientPublicKeys: args.l2Recipient.publicKeys,
      l2RecipientInstance: args.l2Recipient.instance,
      l2RecipientNhkM: args.l2RecipientMasterNullifierHidingKey,
      messageLeafIndex: new Fr(args.messageLeafIndex),
      messageMembershipSiblingPath: msgSiblingPathTuple,
      lowNullifierPreimage: lowNullifierMembershipWitness.leafPreimage,
      lowNullifierMembershipWitness: lowNullifierMembershipWitness.withoutPreimage(),
      auth,
    },
    { logger },
  );
  logger.info(`Generated frozen-deposit-refund proof (${proof.length} bytes)`);

  return { proof, finalization, publicInputs };
}
