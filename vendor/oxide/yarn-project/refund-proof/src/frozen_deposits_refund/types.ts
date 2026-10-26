import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { type ARCHIVE_HEIGHT, L1_TO_L2_MSG_TREE_HEIGHT, NULLIFIER_TREE_HEIGHT } from '@aztec-labs/constants';
import type { GrumpkinScalar } from '@aztec-labs/foundation/curves/grumpkin';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';
import type { Logger } from '@aztec-labs/foundation/log';
import type { Tuple } from '@aztec-labs/foundation/serialize';
import { MembershipWitness } from '@aztec-labs/foundation/trees';
import type { PublicKeys } from '@aztec-labs/stdlib/keys';
import { NullifierLeafPreimage } from '@aztec-labs/stdlib/trees';
import type { BlockHeader } from '@aztec-labs/stdlib/tx';

import type { AccountInstancePreimage } from '@oxide/oxide-lib/account_address.js';
import type { MigrationSignature } from '@oxide/oxide-lib/migration_signature.js';
import { MAX_FROZEN_DEPOSITS_PER_REFUND } from '@oxide/oxide-lib/oxide_constants.gen.js';

export { MAX_FROZEN_DEPOSITS_PER_REFUND };

export class RefundInputDeposit {
  constructor(
    public readonly amount: bigint,
    public readonly sharedSecretSalt: Fr,
    public readonly messageLeafIndex: Fr,
    public readonly messageMembershipSiblingPath: Tuple<Fr, typeof L1_TO_L2_MSG_TREE_HEIGHT>,
    public readonly lowNullifierPreimage: NullifierLeafPreimage,
    public readonly lowNullifierMembershipWitness: MembershipWitness<typeof NULLIFIER_TREE_HEIGHT>,
  ) {}

  /**
   * Padding input deposit. `amount === 0n` makes the circuit skip every per-deposit check (message membership and
   * nullifier non-membership), so all of the fields below can be empty. The circuit ignores all of it.
   */
  static padding(): RefundInputDeposit {
    return new RefundInputDeposit(
      0n,
      Fr.zero(),
      Fr.zero(),
      Array(L1_TO_L2_MSG_TREE_HEIGHT).fill(Fr.zero()) as Tuple<Fr, typeof L1_TO_L2_MSG_TREE_HEIGHT>,
      NullifierLeafPreimage.empty(),
      new MembershipWitness<typeof NULLIFIER_TREE_HEIGHT>(
        NULLIFIER_TREE_HEIGHT,
        0n,
        Array(NULLIFIER_TREE_HEIGHT).fill(Fr.zero()) as Tuple<Fr, typeof NULLIFIER_TREE_HEIGHT>,
      ),
    );
  }
}

/**
 * Witnesses + public inputs the `frozen_deposits_refund` Noir circuit needs to refund up to
 * `MAX_FROZEN_DEPOSITS_PER_REFUND` L1->L2 deposits to one recipient that never landed on L2 before the portal froze.
 * The trailing nullifier slots are the circuit's return value, so they aren't supplied here.
 */
export interface FrozenDepositsRefundProofInput {
  // Public inputs (must match `OxidePortal.refundFrozenDeposits` layout).
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
  l2Recipient: AztecAddress;
  l2RecipientPublicKeys: PublicKeys;
  l2RecipientInstance: AccountInstancePreimage;
  l2RecipientNhkM: GrumpkinScalar;
  /** The deposits, padded to `MAX_FROZEN_DEPOSITS_PER_REFUND` with `RefundInputDeposit.padding()`. */
  deposits: Tuple<RefundInputDeposit, typeof MAX_FROZEN_DEPOSITS_PER_REFUND>;
  migrationSignature: MigrationSignature;
}

export interface FrozenDepositsRefundProofOptions {
  logger?: Logger;
}
