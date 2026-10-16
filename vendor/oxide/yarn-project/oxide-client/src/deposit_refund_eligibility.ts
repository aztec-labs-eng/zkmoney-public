import type { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr, type GrumpkinScalar } from '@aztec/aztec.js/fields';
import type { L1_TO_L2_MSG_TREE_HEIGHT } from '@aztec/constants';
import type { InboxContract } from '@aztec/ethereum/contracts';
import type { SiblingPath } from '@aztec/foundation/trees';
import type { BlockHash } from '@aztec/stdlib/block';
import type { CompleteAddress } from '@aztec/stdlib/contract';
import { derivePublicKeyFromSecretKey, hashPublicKey } from '@aztec/stdlib/keys';
import { MerkleTreeId } from '@aztec/stdlib/trees';
import type { BlockHeader } from '@aztec/stdlib/tx';

import type { OxidePortalContract } from '@oxide/l1-contracts';
import {
  computeDepositMessageHash,
  computeSiloedDepositMessageNullifier,
} from '@oxide/oxide-lib/deposit_message_hashing.js';

import { type ArchiveRef, resolveFreezeArchive } from './archive_ref.js';
import type { ChainDataSource } from './chain_data_source.js';
import { PermanentError } from './errors.js';

export type DepositPortalContext = Pick<
  OxidePortalContract,
  'address' | 'getChainId' | 'getL2Portal' | 'getRollupVersion'
>;

export type DepositRefundPortal = DepositPortalContext &
  Pick<OxidePortalContract, 'getFreezeArchive' | 'isRefundNullifierSpent'>;

export type DepositInbox = Pick<InboxContract, 'getMessageSentEvents'> & {
  client: Pick<InboxContract['client'], 'getBlock'>;
};

export interface DepositRefundCandidate {
  messageKey: Fr;
  messageLeafIndex: bigint;
  /** The L1 block of the `Deposit` event. The Inbox inserted the deposit message in the same transaction. */
  l1BlockNumber: bigint;
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
 * - `frozen-deposit`: the archive has the message, but not its nullifier. Use `refundFrozenDeposit`.
 * - `unprocessed-deposit`: the L1 Inbox has the message, but the archive does not. Use `refundUnprocessedDeposit`.
 * - `consumed`: an L2 transaction spent the deposit before the freeze. Use `refundFrozenNotes` for its unspent notes.
 * - `refunded`: the portal recorded the nullifier.
 */
export type DepositRefundKind = 'frozen-deposit' | 'unprocessed-deposit' | 'consumed' | 'refunded';

export interface DepositRefundEligibility {
  kind: DepositRefundKind;
  /** The siloed deposit nullifier: an L2 spend emits it, and a deposit refund records it in the portal. */
  nullifier: Fr;
}

export async function computePortalDepositMessageHash(
  portal: DepositPortalContext,
  deposit: DepositMessagePreimage,
): Promise<{ messageHash: Fr; l2Portal: AztecAddress }> {
  const [l2Portal, rollupVersion] = await Promise.all([portal.getL2Portal(), portal.getRollupVersion()]);
  const messageHash = await computeDepositMessageHash(
    { l1Portal: portal.address, l1ChainId: portal.getChainId(), l2Portal, rollupVersion },
    {
      sharedSecretSalt: deposit.sharedSecretSalt,
      recipient: deposit.recipient,
      amount: deposit.amount,
      messageLeafIndex: new Fr(deposit.messageLeafIndex),
    },
  );
  return { messageHash, l2Portal };
}

/**
 * `recipient.publicKeys` must hash to `recipient.address`. A `CompleteAddress` does, and so does a `RefundOwner` that
 * `deriveRefundOwnerAddress` checked.
 */
export async function computeDepositRefundNullifier(
  portal: DepositPortalContext,
  deposit: Omit<DepositRefundCandidate, 'l1BlockNumber' | 'recipient'> & {
    recipient: Pick<CompleteAddress, 'address' | 'publicKeys'>;
  },
): Promise<{ messageHash: Fr; siloedNullifier: Fr }> {
  const recipient = deposit.recipient.address;
  const { messageHash, l2Portal } = await computePortalDepositMessageHash(portal, { ...deposit, recipient });
  if (!messageHash.equals(deposit.messageKey)) {
    throw new PermanentError(`Deposit preimage hashes to ${messageHash}, expected message key ${deposit.messageKey}`);
  }
  const npkMHash = await hashPublicKey(await derivePublicKeyFromSecretKey(deposit.recipientMasterNullifierHidingKey));
  if (!npkMHash.equals(deposit.recipient.publicKeys.npkMHash)) {
    throw new PermanentError(`The master nullifier hiding key does not belong to recipient ${recipient}`);
  }
  const siloedNullifier = await computeSiloedDepositMessageNullifier(
    l2Portal,
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
 * The message key commits to the leaf index, so a key match identifies the message. A read of one block stays in the
 * block range limit of RPC nodes. A block that is not final gives an `Error`, not a `PermanentError`, because an L1
 * reorg can still move the deposit.
 */
async function isInInbox(
  inbox: DepositInbox,
  deposit: Pick<DepositRefundCandidate, 'messageKey' | 'l1BlockNumber'>,
): Promise<boolean> {
  const [finalized, logs] = await Promise.all([
    inbox.client.getBlock({ blockTag: 'finalized' }),
    inbox.getMessageSentEvents(deposit.l1BlockNumber, deposit.l1BlockNumber),
  ]);
  if (deposit.l1BlockNumber > finalized.number) {
    throw new Error(
      `Deposit L1 block ${deposit.l1BlockNumber} is not final. The finalized L1 block is ${finalized.number}`,
    );
  }
  return logs.some(log => log.args.leaf.equals(deposit.messageKey));
}

/**
 * The portal refunds a deposit only at its freeze archive, the default `archive`. There, `frozen-deposit` and
 * `unprocessed-deposit` mean that the circuit and the portal accept the refund, apart from the authorization and the
 * enclave signature. Give `archive` to resolve it once for many deposits. An unprocessed deposit in an L1 block that is
 * not final gives a retryable `Error`.
 */
export async function classifyDepositRefund(
  portal: DepositRefundPortal,
  inbox: DepositInbox,
  chain: ChainDataSource,
  deposit: DepositRefundCandidate,
  archive?: ArchiveRef,
): Promise<DepositRefundEligibility> {
  const [{ checkpointEndBlockHeader: frozenTip }, { siloedNullifier: nullifier }] = await Promise.all([
    archive ?? resolveFreezeArchive(portal, chain),
    computeDepositRefundNullifier(portal, deposit),
  ]);

  if (await portal.isRefundNullifierSpent(nullifier)) {
    return { kind: 'refunded', nullifier };
  }
  // The Inbox gives the root of an open tree, so an unprocessed deposit needs no wait.
  if (!isAbsorbedAtFrozenTip(frozenTip, deposit.messageLeafIndex)) {
    if (!(await isInInbox(inbox, deposit))) {
      throw new PermanentError(
        `The L1 Inbox does not have deposit message ${deposit.messageKey} in L1 block ${deposit.l1BlockNumber}`,
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
