import type { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr, type GrumpkinScalar } from '@aztec/aztec.js/fields';
import { ARCHIVE_HEIGHT, NOTE_HASH_TREE_HEIGHT, NULLIFIER_TREE_HEIGHT } from '@aztec/constants';
import type { EthAddress } from '@aztec/foundation/eth-address';
import type { Logger } from '@aztec/foundation/log';
import type { Tuple } from '@aztec/foundation/serialize';
import { MembershipWitness } from '@aztec/foundation/trees';
import type { PublicKeys } from '@aztec/stdlib/keys';
import { NullifierLeafPreimage } from '@aztec/stdlib/trees';
import type { BlockHeader } from '@aztec/stdlib/tx';

import type { AccountInstancePreimage } from '@oxide/oxide-lib/account_address.js';
import { MAX_FROZEN_NOTES_PER_REFUND } from '@oxide/oxide-lib/oxide_constants.gen.js';
import type { RefundAuthorization } from '@oxide/oxide-lib/refund_authorization.js';

export { MAX_FROZEN_NOTES_PER_REFUND };

/**
 * Per-note witness fed into the refund circuit. `amount === 0n` marks the slot as padding.
 */
export class RefundInputNote {
  constructor(
    public readonly amount: bigint,
    public readonly randomness: Fr,
    public readonly noteNonce: Fr,
    public readonly noteMembershipWitness: MembershipWitness<typeof NOTE_HASH_TREE_HEIGHT>,
    public readonly lowNullifierPreimage: NullifierLeafPreimage,
    public readonly lowNullifierMembershipWitness: MembershipWitness<typeof NULLIFIER_TREE_HEIGHT>,
  ) {}

  /**
   * Padding input note. `amount === 0n` makes the circuit skip every per-note check (membership and
   * non-membership), so all of the fields below can be empty. The circuit ignores all of it.
   */
  static padding(): RefundInputNote {
    return new RefundInputNote(
      0n,
      Fr.zero(),
      Fr.zero(),
      new MembershipWitness<typeof NOTE_HASH_TREE_HEIGHT>(
        NOTE_HASH_TREE_HEIGHT,
        0n,
        Array(NOTE_HASH_TREE_HEIGHT).fill(Fr.zero()) as Tuple<Fr, typeof NOTE_HASH_TREE_HEIGHT>,
      ),
      NullifierLeafPreimage.empty(),
      new MembershipWitness<typeof NULLIFIER_TREE_HEIGHT>(
        NULLIFIER_TREE_HEIGHT,
        0n,
        Array(NULLIFIER_TREE_HEIGHT).fill(Fr.zero()) as Tuple<Fr, typeof NULLIFIER_TREE_HEIGHT>,
      ),
    );
  }
}

export interface FrozenNotesRefundProofInput {
  chainId: bigint;
  rollupVersion: bigint;
  l1Portal: EthAddress;
  l2Token: AztecAddress;
  frozenArchiveRoot: Fr;
  amount: bigint;
  executor: EthAddress;
  userPayloadHash: Fr;
  frozenTip: BlockHeader;
  frozenTipSiblingPath: Tuple<Fr, typeof ARCHIVE_HEIGHT>;
  notes: Tuple<RefundInputNote, typeof MAX_FROZEN_NOTES_PER_REFUND>;
  /** The owner of every active note. */
  owner: AztecAddress;
  ownerPublicKeys: PublicKeys;
  ownerInstance: AccountInstancePreimage;
  ownerNhkM: GrumpkinScalar;
  auth: RefundAuthorization;
}

export interface FrozenNotesRefundProofOptions {
  logger?: Logger;
}
