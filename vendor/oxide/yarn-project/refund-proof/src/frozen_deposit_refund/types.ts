import type { AztecAddress } from '@aztec/aztec.js/addresses';
import type { Fr } from '@aztec/aztec.js/fields';
import type { ARCHIVE_HEIGHT, L1_TO_L2_MSG_TREE_HEIGHT, NULLIFIER_TREE_HEIGHT } from '@aztec/constants';
import type { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';
import type { EthAddress } from '@aztec/foundation/eth-address';
import type { Logger } from '@aztec/foundation/log';
import type { Tuple } from '@aztec/foundation/serialize';
import type { MembershipWitness } from '@aztec/foundation/trees';
import type { PublicKeys } from '@aztec/stdlib/keys';
import type { NullifierLeafPreimage } from '@aztec/stdlib/trees';
import type { BlockHeader } from '@aztec/stdlib/tx';

import type { AccountInstancePreimage } from '@oxide/oxide-lib/account_address.js';
import type { RefundAuthorization } from '@oxide/oxide-lib/refund_authorization.js';

/**
 * Witnesses + public inputs the `frozen_deposit_refund` Noir circuit needs to refund a
 * single L1->L2 deposit that never landed on L2 before the portal froze. One message per proof.
 * The trailing `siloed_nullifier` slot is the circuit's return value, so it isn't supplied here.
 */
export interface FrozenDepositRefundProofInput {
  // Public inputs (must match `OxidePortal.refundFrozenDeposit` layout).
  chainId: bigint;
  rollupVersion: bigint;
  l2Token: AztecAddress;
  archiveRoot: Fr;
  amount: bigint;
  executor: EthAddress;
  userPayloadHash: Fr;
  // Private inputs.
  frozenTip: BlockHeader;
  frozenTipSiblingPath: Tuple<Fr, typeof ARCHIVE_HEIGHT>;
  l1Portal: EthAddress;
  sharedSecretSalt: Fr;
  l2Recipient: AztecAddress;
  l2RecipientPublicKeys: PublicKeys;
  l2RecipientInstance: AccountInstancePreimage;
  l2RecipientNhkM: GrumpkinScalar;
  messageLeafIndex: Fr;
  messageMembershipSiblingPath: Tuple<Fr, typeof L1_TO_L2_MSG_TREE_HEIGHT>;
  lowNullifierPreimage: NullifierLeafPreimage;
  lowNullifierMembershipWitness: MembershipWitness<typeof NULLIFIER_TREE_HEIGHT>;
  auth: RefundAuthorization;
}

export interface FrozenDepositRefundProofOptions {
  logger?: Logger;
}
