import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr, type GrumpkinScalar } from '@aztec-labs/aztec.js/fields';
import type { L1_TO_L2_MSG_TREE_HEIGHT } from '@aztec-labs/constants';
import type { SiblingPath } from '@aztec-labs/foundation/trees';
import type { BlockHash } from '@aztec-labs/stdlib/block';
import type { CompleteAddress } from '@aztec-labs/stdlib/contract';
import { derivePublicKeyFromSecretKey, hashPublicKey } from '@aztec-labs/stdlib/keys';
import { MerkleTreeId } from '@aztec-labs/stdlib/trees';
import type { BlockHeader } from '@aztec-labs/stdlib/tx';

import type { OxidePortalContract } from '@oxide/l1-contracts';
import {
  computeDepositMessageHash,
  computeSiloedDepositMessageNullifier,
} from '@oxide/oxide-lib/deposit_message_hashing.js';
import type { PortalDomain } from '@oxide/oxide-lib/types.js';

import type { Hex } from 'viem';

import { type ArchiveRef, resolveFreezeArchive } from './archive_ref.js';
import type { ChainDataSource } from './chain_data_source.js';
import { PermanentError } from './errors.js';

/** The portal reads of the classification. `$depositMessageIndex` gives the leaf index plus one of a deposit message. */
export type DepositRefundPortal = Pick<
  OxidePortalContract,
  'getPortalDomain' | 'getFreezeArchive' | 'isRefundNullifierSpent'
> & {
  getContract(): {
    read: {
      $depositMessageIndex(args: readonly [Hex], options?: { blockTag?: 'latest' | 'finalized' }): Promise<bigint>;
    };
  };
};

export interface DepositRefundCandidate {
  messageKey: Fr;
  messageLeafIndex: bigint;
  sharedSecretSalt: Fr;
  /** The credited amount of the `Deposit` event. */
  amount: bigint;
  /** `recipientMasterNullifierHidingKey` must derive the `npk_m` hash in the public keys of this address. */
  recipient: CompleteAddress;
  recipientMasterNullifierHidingKey: GrumpkinScalar;
}

export interface DepositMessagePreimage {
  sharedSecretSalt: Fr;
  recipient: AztecAddress;
  amount: bigint;
  messageLeafIndex: bigint;
}

/**
 * The refund path of a deposit at a frozen archive:
 * - `frozen-deposit`: the archive has the message, but not its nullifier. Use `refundFrozenDeposits`.
 * - `unprocessed-deposit`: the portal recorded the deposit message, but the archive does not have it. Use
 *   `refundUnprocessedDeposit`.
 * - `consumed`: an L2 transaction spent the deposit before the freeze. Use `refundFrozenNotes` for its unspent notes.
 * - `refunded`: the portal recorded the nullifier.
 */
export type DepositRefundKind = 'frozen-deposit' | 'unprocessed-deposit' | 'consumed' | 'refunded';

export interface DepositRefundEligibility {
  kind: DepositRefundKind;
  /** The siloed deposit nullifier: an L2 spend emits it, and a deposit refund records it in the portal. */
  nullifier: Fr;
}

export function computePortalDepositMessageHash(
  portalDomain: PortalDomain,
  deposit: DepositMessagePreimage,
): Promise<Fr> {
  return computeDepositMessageHash(portalDomain, {
    sharedSecretSalt: deposit.sharedSecretSalt,
    recipient: deposit.recipient,
    amount: deposit.amount,
    messageLeafIndex: new Fr(deposit.messageLeafIndex),
  });
}

/**
 * `recipient.publicKeys` must hash to `recipient.address`. A `CompleteAddress` does, and so does a `RefundOwner` that
 * `assertRefundOwner` checked.
 */
export async function computeDepositRefundNullifier(
  portalDomain: PortalDomain,
  deposit: Omit<DepositRefundCandidate, 'recipient'> & {
    recipient: Pick<CompleteAddress, 'address' | 'publicKeys'>;
  },
): Promise<{ messageHash: Fr; siloedNullifier: Fr }> {
  const recipient = deposit.recipient.address;
  const messageHash = await computePortalDepositMessageHash(portalDomain, { ...deposit, recipient });
  if (!messageHash.equals(deposit.messageKey)) {
    throw new PermanentError(`Deposit preimage hashes to ${messageHash}, expected message key ${deposit.messageKey}`);
  }
  const npkMHash = await hashPublicKey(await derivePublicKeyFromSecretKey(deposit.recipientMasterNullifierHidingKey));
  if (!npkMHash.equals(deposit.recipient.publicKeys.npkMHash)) {
    throw new PermanentError(`The master nullifier hiding key does not belong to recipient ${recipient}`);
  }
  const siloedNullifier = await computeSiloedDepositMessageNullifier(
    portalDomain.l2Token,
    messageHash,
    deposit.recipientMasterNullifierHidingKey,
  );
  return { messageHash, siloedNullifier };
}

/** The deposit refund circuits use the same rule. */
export function isAbsorbedAtFrozenTip(frozenTip: BlockHeader, messageLeafIndex: bigint): boolean {
  return messageLeafIndex < BigInt(frozenTip.state.l1ToL2MessageTree.nextAvailableLeafIndex);
}

export async function getDepositMessageSiblingPath(
  chain: Pick<ChainDataSource, 'getL1ToL2MessageMembershipWitness'>,
  blockHash: BlockHash,
  deposit: Pick<DepositRefundCandidate, 'messageKey' | 'messageLeafIndex'>,
): Promise<SiblingPath<typeof L1_TO_L2_MSG_TREE_HEIGHT> | undefined> {
  const witness = await chain.getL1ToL2MessageMembershipWitness(blockHash, deposit.messageKey);
  if (!witness) {
    return undefined;
  }
  const [leafIndex, siblingPath] = witness;
  if (leafIndex !== deposit.messageLeafIndex) {
    throw new PermanentError(
      `Deposit witness leaf index ${leafIndex} does not match deposit leaf index ${deposit.messageLeafIndex}`,
    );
  }
  return siblingPath;
}

export async function getFrozenDepositMessageSiblingPath(
  chain: Pick<ChainDataSource, 'getL1ToL2MessageMembershipWitness'>,
  frozenTip: BlockHeader,
  deposit: Pick<DepositRefundCandidate, 'messageKey' | 'messageLeafIndex'>,
): Promise<SiblingPath<typeof L1_TO_L2_MSG_TREE_HEIGHT>> {
  if (!isAbsorbedAtFrozenTip(frozenTip, deposit.messageLeafIndex)) {
    throw new PermanentError(
      `The frozen tip did not absorb the deposit message at leaf index ${deposit.messageLeafIndex}, so it is not a frozen deposit`,
    );
  }
  const frozenTipHash = await frozenTip.hash();
  const siblingPath = await getDepositMessageSiblingPath(chain, frozenTipHash, deposit);
  if (!siblingPath) {
    throw new PermanentError(
      `Frozen tip ${frozenTipHash} absorbed leaf index ${deposit.messageLeafIndex}, but does not have deposit message ${deposit.messageKey}`,
    );
  }
  return siblingPath;
}

/**
 * The portal records the leaf index of each deposit message, and `refundUnprocessedDeposit` accepts only a recorded
 * message at its leaf index. The read at the finalized L1 block makes sure that an L1 reorg cannot remove the record.
 * A record that only the latest L1 block has gives an `Error`, not a `PermanentError`, because the deposit can still
 * become final.
 */
async function isRecordedByPortal(
  portal: DepositRefundPortal,
  deposit: Pick<DepositRefundCandidate, 'messageKey' | 'messageLeafIndex'>,
): Promise<boolean> {
  const read = portal.getContract().read;
  const key = deposit.messageKey.toString() as Hex;
  const expected = deposit.messageLeafIndex + 1n;
  if ((await read.$depositMessageIndex([key], { blockTag: 'finalized' })) === expected) {
    return true;
  }
  if ((await read.$depositMessageIndex([key], { blockTag: 'latest' })) === expected) {
    throw new Error(`The portal recorded deposit message ${deposit.messageKey} in an L1 block that is not final`);
  }
  return false;
}

/**
 * The portal refunds a deposit only at its freeze archive, the default `archive`. There, `frozen-deposit` and
 * `unprocessed-deposit` mean that the circuit and the portal accept the refund, apart from the migration signature and the
 * enclave signature. Give `archive` to resolve it once for many deposits. An unprocessed deposit in an L1 block that is
 * not final gives a retryable `Error`.
 */
export async function classifyDepositRefund(
  portal: DepositRefundPortal,
  chain: ChainDataSource,
  deposit: DepositRefundCandidate,
  archive?: ArchiveRef,
): Promise<DepositRefundEligibility> {
  const [{ checkpointEndBlockHeader: frozenTip }, { siloedNullifier: nullifier }] = await Promise.all([
    archive ?? resolveFreezeArchive(portal, chain),
    portal.getPortalDomain().then(portalDomain => computeDepositRefundNullifier(portalDomain, deposit)),
  ]);

  if (await portal.isRefundNullifierSpent(nullifier)) {
    return { kind: 'refunded', nullifier };
  }
  if (!isAbsorbedAtFrozenTip(frozenTip, deposit.messageLeafIndex)) {
    if (!(await isRecordedByPortal(portal, deposit))) {
      throw new PermanentError(
        `The portal did not record deposit message ${deposit.messageKey} at leaf index ${deposit.messageLeafIndex}`,
      );
    }
    return { kind: 'unprocessed-deposit', nullifier };
  }

  const frozenTipHash = await frozenTip.hash();
  const [, [spent]] = await Promise.all([
    getFrozenDepositMessageSiblingPath(chain, frozenTip, deposit),
    chain.findLeavesIndexes(frozenTipHash, MerkleTreeId.NULLIFIER_TREE, [nullifier]),
  ]);
  return { kind: spent === undefined ? 'frozen-deposit' : 'consumed', nullifier };
}
