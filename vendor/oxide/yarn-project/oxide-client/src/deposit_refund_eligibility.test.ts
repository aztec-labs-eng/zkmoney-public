import { AztecAddress, EthAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr, type GrumpkinScalar } from '@aztec-labs/aztec.js/fields';
import { L1_TO_L2_MSG_TREE_HEIGHT } from '@aztec-labs/constants';
import { BlockNumber, CheckpointNumber, TreeLeafIndex } from '@aztec-labs/foundation/branded-types';
import { SiblingPath } from '@aztec-labs/foundation/trees';
import { CompleteAddress } from '@aztec-labs/stdlib/contract';
import { deriveKeys } from '@aztec-labs/stdlib/keys';
import { AppendOnlyTreeSnapshot } from '@aztec-labs/stdlib/trees';
import { BlockHeader, PartialStateReference, StateReference } from '@aztec-labs/stdlib/tx';

import {
  computeDepositMessageHash,
  computeSiloedDepositMessageNullifier,
} from '@oxide/oxide-lib/deposit_message_hashing.js';
import type { PortalDomain } from '@oxide/oxide-lib/types.js';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Hex } from 'viem';

import type { ArchiveRef } from './archive_ref.js';
import type { ChainDataSource } from './chain_data_source.js';
import {
  type DepositRefundCandidate,
  type DepositRefundPortal,
  classifyDepositRefund,
} from './deposit_refund_eligibility.js';
import { PermanentError } from './errors.js';

const NEXT_AVAILABLE_LEAF_INDEX = 2048;
const ABSORBED_LEAF_INDEX = 1029n;

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
      new AppendOnlyTreeSnapshot(Fr.random(), TreeLeafIndex(nextAvailableLeafIndex)),
      PartialStateReference.empty(),
    ),
  });
}

describe('classifyDepositRefund', () => {
  let portalDomain: PortalDomain;
  let freezeArchiveRoot: Fr;
  let frozenTip: BlockHeader;
  let archive: ArchiveRef;
  let portal: DepositRefundPortal;
  let isRefundNullifierSpent: jest.Mock<(nullifier: Fr) => Promise<boolean>>;
  let getL1ToL2MessageMembershipWitness: jest.Mock<ChainDataSource['getL1ToL2MessageMembershipWitness']>;
  let findLeavesIndexes: jest.Mock<ChainDataSource['findLeavesIndexes']>;
  let getBlockData: jest.Mock<ChainDataSource['getBlockData']>;
  let chain: ChainDataSource;
  let latestDepositIndexes: Map<string, bigint>;
  let finalizedDepositIndexes: Map<string, bigint>;
  let depositMessageIndex: jest.Mock<
    (args: readonly [Hex], options?: { blockTag?: 'latest' | 'finalized' }) => Promise<bigint>
  >;

  async function depositAt(messageLeafIndex: bigint): Promise<DepositRefundCandidate> {
    const recipient = await account();
    const preimage = {
      sharedSecretSalt: Fr.random(),
      recipient: recipient.completeAddress.address,
      amount: 1_000n,
      messageLeafIndex: new Fr(messageLeafIndex),
    };
    const messageKey = await computeDepositMessageHash(portalDomain, preimage);
    return {
      ...preimage,
      recipient: recipient.completeAddress,
      messageKey,
      messageLeafIndex,
      recipientMasterNullifierHidingKey: recipient.masterNullifierHidingKey,
    };
  }

  function nullifierOf(deposit: DepositRefundCandidate): Promise<Fr> {
    return computeSiloedDepositMessageNullifier(
      portalDomain.l2Token,
      deposit.messageKey,
      deposit.recipientMasterNullifierHidingKey,
    );
  }

  function recordInPortal(deposit: DepositRefundCandidate, opts: { final: boolean } = { final: true }) {
    const key = deposit.messageKey.toString();
    latestDepositIndexes.set(key, deposit.messageLeafIndex + 1n);
    if (opts.final) {
      finalizedDepositIndexes.set(key, deposit.messageLeafIndex + 1n);
    }
  }

  function holdMessageAt(leafIndex: bigint) {
    getL1ToL2MessageMembershipWitness.mockResolvedValue([leafIndex, SiblingPath.random(L1_TO_L2_MSG_TREE_HEIGHT)]);
  }

  beforeEach(async () => {
    portalDomain = {
      l1Portal: EthAddress.random(),
      l1ChainId: 31337n,
      l2Token: await AztecAddress.random(),
      teeRegistry: EthAddress.random(),
      rollupVersion: 7n,
    };
    freezeArchiveRoot = Fr.random();
    frozenTip = frozenTipWith(NEXT_AVAILABLE_LEAF_INDEX);
    archive = {
      root: freezeArchiveRoot,
      checkpointNumber: CheckpointNumber(2),
      checkpointEndBlockHeader: frozenTip,
    };
    isRefundNullifierSpent = jest.fn<(nullifier: Fr) => Promise<boolean>>().mockResolvedValue(false);
    latestDepositIndexes = new Map();
    finalizedDepositIndexes = new Map();
    depositMessageIndex = jest.fn((args: readonly [Hex], options?: { blockTag?: 'latest' | 'finalized' }) => {
      const indexes = options?.blockTag === 'finalized' ? finalizedDepositIndexes : latestDepositIndexes;
      return Promise.resolve(indexes.get(args[0]) ?? 0n);
    });
    portal = {
      getPortalDomain: () => Promise.resolve(portalDomain),
      getFreezeArchive: () => Promise.resolve(freezeArchiveRoot),
      isRefundNullifierSpent,
      getContract: () => ({ read: { $depositMessageIndex: depositMessageIndex } }),
    };
    getL1ToL2MessageMembershipWitness = jest.fn<ChainDataSource['getL1ToL2MessageMembershipWitness']>();
    findLeavesIndexes = jest.fn<ChainDataSource['findLeavesIndexes']>().mockResolvedValue([undefined]);
    getBlockData = jest.fn<ChainDataSource['getBlockData']>();
    chain = { getL1ToL2MessageMembershipWitness, findLeavesIndexes, getBlockData } as unknown as ChainDataSource;
  });

  it('classifies an absorbed deposit whose nullifier the frozen tip does not have as a frozen deposit', async () => {
    const deposit = await depositAt(ABSORBED_LEAF_INDEX);
    holdMessageAt(ABSORBED_LEAF_INDEX);

    const eligibility = await classifyDepositRefund(portal, chain, deposit, archive);

    expect(eligibility).toEqual({ kind: 'frozen-deposit', nullifier: await nullifierOf(deposit) });
    expect(depositMessageIndex).not.toHaveBeenCalled();
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

    expect(await classifyDepositRefund(portal, chain, deposit, archive)).toEqual({
      kind: 'consumed',
      nullifier: await nullifierOf(deposit),
    });
  });

  it('classifies a deposit at the next available leaf index of the frozen tip as unprocessed', async () => {
    const deposit = await depositAt(BigInt(NEXT_AVAILABLE_LEAF_INDEX));
    recordInPortal(deposit);

    expect(await classifyDepositRefund(portal, chain, deposit, archive)).toEqual({
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

      expect(await classifyDepositRefund(portal, chain, deposit, archive)).toEqual({
        kind: 'refunded',
        nullifier,
      });
      expect(getL1ToL2MessageMembershipWitness).not.toHaveBeenCalled();
      expect(depositMessageIndex).not.toHaveBeenCalled();
    },
  );

  it('judges the deposit against the freeze archive of the portal by default', async () => {
    getBlockData.mockResolvedValue({ checkpointNumber: archive.checkpointNumber, header: frozenTip } as any);
    const deposit = await depositAt(ABSORBED_LEAF_INDEX);
    holdMessageAt(ABSORBED_LEAF_INDEX);

    expect((await classifyDepositRefund(portal, chain, deposit)).kind).toBe('frozen-deposit');
    expect(getBlockData).toHaveBeenCalledWith({ archive: freezeArchiveRoot });
  });

  it('refuses to use a default archive while the portal is not frozen', async () => {
    freezeArchiveRoot = Fr.ZERO;
    const deposit = await depositAt(ABSORBED_LEAF_INDEX);

    await expect(classifyDepositRefund(portal, chain, deposit)).rejects.toThrow(/not frozen/);
    expect(isRefundNullifierSpent).not.toHaveBeenCalled();
  });

  it('rejects a preimage that does not hash to the message key', async () => {
    const deposit = { ...(await depositAt(ABSORBED_LEAF_INDEX)), amount: 999n };

    const error = await classifyDepositRefund(portal, chain, deposit, archive).catch(e => e);
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

      await expect(classifyDepositRefund(portal, chain, withOtherKey, archive)).rejects.toBeInstanceOf(PermanentError);
    });

    it('for a deposit that the portal refunded', async () => {
      isRefundNullifierSpent.mockImplementation(n => Promise.resolve(n.equals(nullifier)));

      await expect(classifyDepositRefund(portal, chain, withOtherKey, archive)).rejects.toBeInstanceOf(PermanentError);
    });
  });

  it('reads the deposit record of the portal at the finalized L1 block', async () => {
    const deposit = await depositAt(BigInt(NEXT_AVAILABLE_LEAF_INDEX));
    recordInPortal(deposit);

    await classifyDepositRefund(portal, chain, deposit, archive);

    expect(depositMessageIndex).toHaveBeenCalledTimes(1);
    expect(depositMessageIndex).toHaveBeenCalledWith([deposit.messageKey.toString()], { blockTag: 'finalized' });
  });

  it('rejects an unprocessed deposit whose message the portal did not record', async () => {
    const deposit = await depositAt(BigInt(NEXT_AVAILABLE_LEAF_INDEX) + 5n);

    await expect(classifyDepositRefund(portal, chain, deposit, archive)).rejects.toStrictEqual(
      new PermanentError(
        `The portal did not record deposit message ${deposit.messageKey} at leaf index ${deposit.messageLeafIndex}`,
      ),
    );
  });

  it('rejects an unprocessed deposit that the portal recorded at another leaf index', async () => {
    const deposit = await depositAt(BigInt(NEXT_AVAILABLE_LEAF_INDEX));
    recordInPortal({ ...deposit, messageLeafIndex: deposit.messageLeafIndex + 1n });

    await expect(classifyDepositRefund(portal, chain, deposit, archive)).rejects.toBeInstanceOf(PermanentError);
  });

  it('refuses to judge an unprocessed deposit until its L1 block is final', async () => {
    const deposit = await depositAt(BigInt(NEXT_AVAILABLE_LEAF_INDEX));
    recordInPortal(deposit, { final: false });

    await expect(classifyDepositRefund(portal, chain, deposit, archive)).rejects.toStrictEqual(
      new Error(`The portal recorded deposit message ${deposit.messageKey} in an L1 block that is not final`),
    );
  });

  it('rejects an absorbed leaf index whose message the frozen tree does not have', async () => {
    const deposit = await depositAt(ABSORBED_LEAF_INDEX);
    getL1ToL2MessageMembershipWitness.mockResolvedValue(undefined);

    await expect(classifyDepositRefund(portal, chain, deposit, archive)).rejects.toStrictEqual(
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

      await expect(classifyDepositRefund(portal, chain, deposit, archive)).rejects.toBe(failure);
    });

    it('when the L1-to-L2 message witness read fails', async () => {
      getL1ToL2MessageMembershipWitness.mockRejectedValue(failure);
      const deposit = await depositAt(ABSORBED_LEAF_INDEX);

      await expect(classifyDepositRefund(portal, chain, deposit, archive)).rejects.toBe(failure);
    });

    it('when the portal deposit record read fails', async () => {
      depositMessageIndex.mockRejectedValue(failure);
      const deposit = await depositAt(BigInt(NEXT_AVAILABLE_LEAF_INDEX));

      await expect(classifyDepositRefund(portal, chain, deposit, archive)).rejects.toBe(failure);
    });

    it('when the nullifier tree read fails', async () => {
      findLeavesIndexes.mockRejectedValue(failure);
      const deposit = await depositAt(ABSORBED_LEAF_INDEX);
      holdMessageAt(ABSORBED_LEAF_INDEX);

      await expect(classifyDepositRefund(portal, chain, deposit, archive)).rejects.toBe(failure);
    });
  });
});
