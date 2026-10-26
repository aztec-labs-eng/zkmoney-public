import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr, type GrumpkinScalar } from '@aztec-labs/aztec.js/fields';
import { ARCHIVE_HEIGHT, NOTE_HASH_TREE_HEIGHT, NULLIFIER_TREE_HEIGHT } from '@aztec-labs/constants';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';
import type { Logger } from '@aztec-labs/foundation/log';
import type { Tuple } from '@aztec-labs/foundation/serialize';
import { MembershipWitness } from '@aztec-labs/foundation/trees';
import type { PublicKeys } from '@aztec-labs/stdlib/keys';
import { NullifierLeafPreimage } from '@aztec-labs/stdlib/trees';
import type { BlockHeader } from '@aztec-labs/stdlib/tx';

import type { AccountInstancePreimage } from '@oxide/oxide-lib/account_address.js';
import type { MigrationSignature } from '@oxide/oxide-lib/migration_signature.js';
import { MAX_FROZEN_NOTES_PER_REFUND } from '@oxide/oxide-lib/oxide_constants.gen.js';

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
  migrationSignature: MigrationSignature;
}

export interface FrozenNotesRefundProofOptions {
  logger?: Logger;
}
