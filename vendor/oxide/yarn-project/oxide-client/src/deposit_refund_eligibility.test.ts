import { AztecAddress, EthAddress } from '@aztec/aztec.js/addresses';
import { Fr, type GrumpkinScalar } from '@aztec/aztec.js/fields';
import { L1_TO_L2_MSG_TREE_HEIGHT } from '@aztec/constants';
import { BlockNumber, CheckpointNumber } from '@aztec/foundation/branded-types';
import { SiblingPath } from '@aztec/foundation/trees';
import { CompleteAddress } from '@aztec/stdlib/contract';
import { deriveKeys } from '@aztec/stdlib/keys';
import { AppendOnlyTreeSnapshot } from '@aztec/stdlib/trees';
import { BlockHeader, PartialStateReference, StateReference } from '@aztec/stdlib/tx';

import {
  computeDepositMessageHash,
  computeSiloedDepositMessageNullifier,
} from '@oxide/oxide-lib/deposit_message_hashing.js';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { ArchiveRef } from './archive_ref.js';
import type { ChainDataSource } from './chain_data_source.js';
import {
  type DepositInbox,
  type DepositRefundCandidate,
  type DepositRefundPortal,
  classifyDepositRefund,
} from './deposit_refund_eligibility.js';
import { PermanentError } from './errors.js';

const NEXT_AVAILABLE_LEAF_INDEX = 2048;
const ABSORBED_LEAF_INDEX = 1029n;

interface InboxMessage {
  leaf: Fr;
  l1BlockNumber: bigint;
}

interface Account {
  completeAddress: CompleteAddress;
  masterNullifierHidingKey: GrumpkinScalar;
}

async function account(): Promise<Account> {
  const secret = Fr.random();
  return {
    completeAddress: await CompleteAddress.fromSecretKeyAndPartialAddress(secret, Fr.random()),
    masterNullifierHidingKey: (await deriveKeys(secret)).masterNullifierHidingSecretKey,
  };
}

function frozenTipWith(nextAvailableLeafIndex: number): BlockHeader {
  return BlockHeader.empty({
    state: new StateReference(
      new AppendOnlyTreeSnapshot(Fr.random(), nextAvailableLeafIndex),
      PartialStateReference.empty(),
    ),
  });
}

describe('classifyDepositRefund', () => {
  let l2Portal: AztecAddress;
  let freezeArchiveRoot: Fr;
  let frozenTip: BlockHeader;
  let archive: ArchiveRef;
  let portal: DepositRefundPortal;
  let isRefundNullifierSpent: jest.Mock<(nullifier: Fr) => Promise<boolean>>;
  let getL1ToL2MessageMembershipWitness: jest.Mock<ChainDataSource['getL1ToL2MessageMembershipWitness']>;
  let findLeavesIndexes: jest.Mock<ChainDataSource['findLeavesIndexes']>;
  let getBlockData: jest.Mock<ChainDataSource['getBlockData']>;
  let chain: ChainDataSource;
  let inboxMessages: InboxMessage[];
  let getMessageSentEvents: jest.Mock<(fromBlock: bigint, toBlock: bigint) => Promise<unknown>>;
  let finalizedL1Block: bigint;
  let inbox: DepositInbox;

  async function depositAt(messageLeafIndex: bigint): Promise<DepositRefundCandidate> {
    const recipient = await account();
    const preimage = {
      sharedSecretSalt: Fr.random(),
      recipient: recipient.completeAddress.address,
      amount: 1_000n,
      messageLeafIndex: new Fr(messageLeafIndex),
    };
    const messageKey = await computeDepositMessageHash(
      {
        l1Portal: portal.address,
        l1ChainId: portal.getChainId(),
        l2Portal,
        rollupVersion: await portal.getRollupVersion(),
      },
      preimage,
    );
    return {
      ...preimage,
      recipient: recipient.completeAddress,
      messageKey,
      messageLeafIndex,
      l1BlockNumber: 500n + messageLeafIndex,
      recipientMasterNullifierHidingKey: recipient.masterNullifierHidingKey,
    };
  }

  function nullifierOf(deposit: DepositRefundCandidate): Promise<Fr> {
    return computeSiloedDepositMessageNullifier(
      l2Portal,
      deposit.messageKey,
      deposit.recipientMasterNullifierHidingKey,
    );
  }

  function sendToInbox(deposit: DepositRefundCandidate) {
    inboxMessages.push({ leaf: deposit.messageKey, l1BlockNumber: deposit.l1BlockNumber });
  }

  function holdMessageAt(leafIndex: bigint) {
    getL1ToL2MessageMembershipWitness.mockResolvedValue([leafIndex, SiblingPath.random(L1_TO_L2_MSG_TREE_HEIGHT)]);
  }

  beforeEach(async () => {
    l2Portal = await AztecAddress.random();
    freezeArchiveRoot = Fr.random();
    frozenTip = frozenTipWith(NEXT_AVAILABLE_LEAF_INDEX);
    archive = {
      root: freezeArchiveRoot,
      checkpointNumber: CheckpointNumber(2),
      checkpointEndBlockHeader: frozenTip,
      witnessReferenceBlockNumber: BlockNumber(5),
    };
    isRefundNullifierSpent = jest.fn<(nullifier: Fr) => Promise<boolean>>().mockResolvedValue(false);
    portal = {
      address: EthAddress.random(),
      getChainId: () => 31337n,
      getL2Portal: () => Promise.resolve(l2Portal),
      getRollupVersion: () => Promise.resolve(7n),
      getFreezeArchive: () => Promise.resolve(freezeArchiveRoot),
      isRefundNullifierSpent,
    };
    getL1ToL2MessageMembershipWitness = jest.fn<ChainDataSource['getL1ToL2MessageMembershipWitness']>();
    findLeavesIndexes = jest.fn<ChainDataSource['findLeavesIndexes']>().mockResolvedValue([undefined]);
    getBlockData = jest.fn<ChainDataSource['getBlockData']>();
    chain = { getL1ToL2MessageMembershipWitness, findLeavesIndexes, getBlockData } as unknown as ChainDataSource;
    inboxMessages = [];
    getMessageSentEvents = jest.fn((fromBlock: bigint, toBlock: bigint) =>
      Promise.resolve(
        inboxMessages
          .filter(m => m.l1BlockNumber >= fromBlock && m.l1BlockNumber <= toBlock)
          .map(m => ({ args: { leaf: m.leaf } })),
      ),
    );
    finalizedL1Block = 10_000n;
    inbox = {
      getMessageSentEvents,
      client: { getBlock: () => Promise.resolve({ number: finalizedL1Block }) },
    } as unknown as DepositInbox;
  });

  it('classifies an absorbed deposit whose nullifier the frozen tip does not have as a frozen deposit', async () => {
    const deposit = await depositAt(ABSORBED_LEAF_INDEX);
    holdMessageAt(ABSORBED_LEAF_INDEX);

    const eligibility = await classifyDepositRefund(portal, inbox, chain, deposit, archive);

    expect(eligibility).toEqual({ kind: 'frozen-deposit', nullifier: await nullifierOf(deposit) });
    expect(getMessageSentEvents).not.toHaveBeenCalled();
    const frozenTipHash = await frozenTip.hash();
    expect(getL1ToL2MessageMembershipWitness).toHaveBeenCalledWith(frozenTipHash, deposit.messageKey);
    expect(findLeavesIndexes).toHaveBeenCalledWith(frozenTipHash, expect.anything(), [eligibility.nullifier]);
  });

  it('classifies an absorbed deposit whose nullifier the frozen tip has as consumed', async () => {
    const deposit = await depositAt(ABSORBED_LEAF_INDEX);
    holdMessageAt(ABSORBED_LEAF_INDEX);
    findLeavesIndexes.mockResolvedValue([
      { l2BlockNumber: BlockNumber(3), l2BlockHash: await frozenTip.hash(), data: 64n },
    ]);

    expect(await classifyDepositRefund(portal, inbox, chain, deposit, archive)).toEqual({
      kind: 'consumed',
      nullifier: await nullifierOf(deposit),
    });
  });

  it('classifies a deposit at the next available leaf index of the frozen tip as unprocessed', async () => {
    const deposit = await depositAt(BigInt(NEXT_AVAILABLE_LEAF_INDEX));
    sendToInbox(deposit);

    expect(await classifyDepositRefund(portal, inbox, chain, deposit, archive)).toEqual({
      kind: 'unprocessed-deposit',
      nullifier: await nullifierOf(deposit),
    });
    expect(getL1ToL2MessageMembershipWitness).not.toHaveBeenCalled();
    expect(findLeavesIndexes).not.toHaveBeenCalled();
  });

  it.each([ABSORBED_LEAF_INDEX, BigInt(NEXT_AVAILABLE_LEAF_INDEX)])(
    'classifies a deposit at leaf index %s whose nullifier the portal recorded as refunded',
    async leafIndex => {
      const deposit = await depositAt(leafIndex);
      const nullifier = await nullifierOf(deposit);
      isRefundNullifierSpent.mockImplementation(n => Promise.resolve(n.equals(nullifier)));

      expect(await classifyDepositRefund(portal, inbox, chain, deposit, archive)).toEqual({
        kind: 'refunded',
        nullifier,
      });
      expect(getL1ToL2MessageMembershipWitness).not.toHaveBeenCalled();
      expect(getMessageSentEvents).not.toHaveBeenCalled();
    },
  );

  it('judges the deposit against the freeze archive of the portal by default', async () => {
    getBlockData.mockResolvedValue({ checkpointNumber: archive.checkpointNumber, header: frozenTip } as any);
    const deposit = await depositAt(ABSORBED_LEAF_INDEX);
    holdMessageAt(ABSORBED_LEAF_INDEX);

    expect((await classifyDepositRefund(portal, inbox, chain, deposit)).kind).toBe('frozen-deposit');
    expect(getBlockData).toHaveBeenCalledWith({ archive: freezeArchiveRoot });
  });

  it('refuses to use a default archive while the portal is not frozen', async () => {
    freezeArchiveRoot = Fr.ZERO;
    const deposit = await depositAt(ABSORBED_LEAF_INDEX);

    await expect(classifyDepositRefund(portal, inbox, chain, deposit)).rejects.toThrow(/not frozen/);
    expect(isRefundNullifierSpent).not.toHaveBeenCalled();
  });

  it('rejects a preimage that does not hash to the message key', async () => {
    const deposit = { ...(await depositAt(ABSORBED_LEAF_INDEX)), amount: 999n };

    const error = await classifyDepositRefund(portal, inbox, chain, deposit, archive).catch(e => e);
    expect(error).toBeInstanceOf(PermanentError);
    expect(error.message).toMatch(`expected message key ${deposit.messageKey}`);
  });

  describe('rejects a nullifier hiding key of another account', () => {
    let deposit: DepositRefundCandidate;
    let nullifier: Fr;
    let withOtherKey: DepositRefundCandidate;

    beforeEach(async () => {
      deposit = await depositAt(ABSORBED_LEAF_INDEX);
      nullifier = await nullifierOf(deposit);
      withOtherKey = { ...deposit, recipientMasterNullifierHidingKey: (await account()).masterNullifierHidingKey };
      holdMessageAt(ABSORBED_LEAF_INDEX);
    });

    it('for a deposit that an L2 transaction consumed', async () => {
      const frozenTipHash = await frozenTip.hash();
      findLeavesIndexes.mockImplementation((_blockHash, _treeId, leaves) =>
        Promise.resolve(
          leaves.map(leaf =>
            leaf.equals(nullifier)
              ? { l2BlockNumber: BlockNumber(3), l2BlockHash: frozenTipHash, data: 64n }
              : undefined,
          ),
        ),
      );

      await expect(classifyDepositRefund(portal, inbox, chain, withOtherKey, archive)).rejects.toBeInstanceOf(
        PermanentError,
      );
    });

    it('for a deposit that the portal refunded', async () => {
      isRefundNullifierSpent.mockImplementation(n => Promise.resolve(n.equals(nullifier)));

      await expect(classifyDepositRefund(portal, inbox, chain, withOtherKey, archive)).rejects.toBeInstanceOf(
        PermanentError,
      );
    });
  });

  it('reads the L1 Inbox only in the L1 block of the deposit', async () => {
    const deposit = await depositAt(BigInt(NEXT_AVAILABLE_LEAF_INDEX));
    sendToInbox(deposit);

    await classifyDepositRefund(portal, inbox, chain, deposit, archive);

    expect(getMessageSentEvents).toHaveBeenCalledTimes(1);
    expect(getMessageSentEvents).toHaveBeenCalledWith(deposit.l1BlockNumber, deposit.l1BlockNumber);
  });

  it('rejects an unprocessed deposit whose message the L1 Inbox does not have', async () => {
    const deposit = await depositAt(BigInt(NEXT_AVAILABLE_LEAF_INDEX) + 5n);

    await expect(classifyDepositRefund(portal, inbox, chain, deposit, archive)).rejects.toStrictEqual(
      new PermanentError(
        `The L1 Inbox does not have deposit message ${deposit.messageKey} in L1 block ${deposit.l1BlockNumber}`,
      ),
    );
  });

  it('refuses to judge an unprocessed deposit until its L1 block is final', async () => {
    const deposit = await depositAt(BigInt(NEXT_AVAILABLE_LEAF_INDEX));
    sendToInbox(deposit);
    finalizedL1Block = deposit.l1BlockNumber - 1n;

    await expect(classifyDepositRefund(portal, inbox, chain, deposit, archive)).rejects.toStrictEqual(
      new Error(
        `Deposit L1 block ${deposit.l1BlockNumber} is not final. The finalized L1 block is ${finalizedL1Block}`,
      ),
    );
  });

  it('rejects an absorbed leaf index whose message the frozen tree does not have', async () => {
    const deposit = await depositAt(ABSORBED_LEAF_INDEX);
    getL1ToL2MessageMembershipWitness.mockResolvedValue(undefined);

    await expect(classifyDepositRefund(portal, inbox, chain, deposit, archive)).rejects.toStrictEqual(
      new PermanentError(
        `Frozen tip ${await frozenTip.hash()} absorbed leaf index ${ABSORBED_LEAF_INDEX}, but does not have deposit message ${deposit.messageKey}`,
      ),
    );
  });

  describe('a failed read throws and does not give a kind', () => {
    const failure = new Error('rpc unavailable');

    it('when the portal refund nullifier read fails', async () => {
      isRefundNullifierSpent.mockRejectedValue(failure);
      const deposit = await depositAt(BigInt(NEXT_AVAILABLE_LEAF_INDEX));

      await expect(classifyDepositRefund(portal, inbox, chain, deposit, archive)).rejects.toBe(failure);
    });

    it('when the L1-to-L2 message witness read fails', async () => {
      getL1ToL2MessageMembershipWitness.mockRejectedValue(failure);
      const deposit = await depositAt(ABSORBED_LEAF_INDEX);

      await expect(classifyDepositRefund(portal, inbox, chain, deposit, archive)).rejects.toBe(failure);
    });

    it('when the L1 Inbox read fails', async () => {
      getMessageSentEvents.mockRejectedValue(failure);
      const deposit = await depositAt(BigInt(NEXT_AVAILABLE_LEAF_INDEX));

      await expect(classifyDepositRefund(portal, inbox, chain, deposit, archive)).rejects.toBe(failure);
    });

    it('when the nullifier tree read fails', async () => {
      findLeavesIndexes.mockRejectedValue(failure);
      const deposit = await depositAt(ABSORBED_LEAF_INDEX);
      holdMessageAt(ABSORBED_LEAF_INDEX);

      await expect(classifyDepositRefund(portal, inbox, chain, deposit, archive)).rejects.toBe(failure);
    });
  });
});
