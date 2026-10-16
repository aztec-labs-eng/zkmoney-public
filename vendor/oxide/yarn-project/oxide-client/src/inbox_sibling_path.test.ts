import { Fr } from '@aztec/aztec.js/fields';
import { L1_TO_L2_MSG_SUBTREE_HEIGHT } from '@aztec/constants';
import { MerkleTreeCalculator, computeRootFromSiblingPath, shaMerkleHash } from '@aztec/foundation/trees';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { type InboxMessageSource, buildInboxSiblingPath } from './inbox_sibling_path.js';

const sha = (left: Buffer, right: Buffer) => Promise.resolve(shaMerkleHash(left, right));

interface InboxMessage {
  index: bigint;
  leaf: Fr;
  l1BlockNumber: bigint;
}

const LATEST_L1_BLOCK = 200_000n;
const DEPOSIT = { messageLeafIndex: 1027n, l1BlockNumber: 75_000n };
const CHECKPOINT_BLOCKS = new Map([
  [1024n, 60_000n],
  [1025n, 69_000n],
  [1026n, 71_000n],
  [1027n, DEPOSIT.l1BlockNumber],
  [1028n, 76_000n],
  [1029n, 90_000n],
]);
const PREVIOUS_CHECKPOINT_BLOCKS = new Map([
  [1022n, 50_000n],
  [1023n, 50_100n],
]);

async function checkpointRoot(messages: InboxMessage[]): Promise<Buffer> {
  const calculator = await MerkleTreeCalculator.create(L1_TO_L2_MSG_SUBTREE_HEIGHT, undefined, sha);
  return await calculator.computeTreeRoot(
    messages.filter(m => m.index >= 1024n && m.index < 2048n).map(m => m.leaf.toBuffer()),
  );
}

describe('buildInboxSiblingPath', () => {
  let messages: InboxMessage[];
  let omittedFromLogs: bigint[];
  let latestL1Block: bigint;
  let getMessageSentEvents: jest.Mock<(fromBlock: bigint, toBlock: bigint) => Promise<unknown>>;
  let inbox: InboxMessageSource;

  async function rootFromPath(path: Fr[]): Promise<Buffer> {
    const depositLeaf = messages.find(m => m.index === DEPOSIT.messageLeafIndex)!.leaf.toBuffer();
    return await computeRootFromSiblingPath(
      depositLeaf,
      path.map(node => node.toBuffer()),
      Number(DEPOSIT.messageLeafIndex % 1024n),
      sha,
    );
  }

  beforeEach(() => {
    messages = [...CHECKPOINT_BLOCKS, ...PREVIOUS_CHECKPOINT_BLOCKS].map(([index, l1BlockNumber]) => ({
      index,
      leaf: Fr.random(),
      l1BlockNumber,
    }));
    omittedFromLogs = [];
    latestL1Block = LATEST_L1_BLOCK;
    getMessageSentEvents = jest.fn((fromBlock: bigint, toBlock: bigint) =>
      Promise.resolve(
        messages
          .filter(m => m.l1BlockNumber >= fromBlock && m.l1BlockNumber <= toBlock && !omittedFromLogs.includes(m.index))
          .map(m => ({ args: { index: m.index, leaf: m.leaf } })),
      ),
    );
    const getRoot = async ([checkpoint]: readonly [bigint], { blockNumber }: { blockNumber: bigint }) => {
      expect(checkpoint).toBe(2n);
      const root = await checkpointRoot(messages.filter(m => m.l1BlockNumber <= blockNumber));
      return Fr.fromBuffer(root).toString();
    };
    inbox = {
      getMessageSentEvents,
      getContract: () => ({ read: { getRoot } }),
      client: { getBlockNumber: () => Promise.resolve(latestL1Block) },
    } as unknown as InboxMessageSource;
  });

  it('proves the deposit message against the Inbox root of its checkpoint', async () => {
    const path = await buildInboxSiblingPath(inbox, DEPOSIT);

    expect(await rootFromPath(path)).toEqual(await checkpointRoot(messages));
  });

  it('proves the deposit message against the Inbox root at the latest L1 block', async () => {
    const messagesAtLatest = [...messages];
    messages.push({ index: 1030n, leaf: Fr.random(), l1BlockNumber: LATEST_L1_BLOCK + 1n });

    const path = await buildInboxSiblingPath(inbox, DEPOSIT);

    expect(await rootFromPath(path)).toEqual(await checkpointRoot(messagesAtLatest));
  });

  it('builds the path again after a new message changes the Inbox root', async () => {
    const stalePath = await buildInboxSiblingPath(inbox, DEPOSIT);
    latestL1Block += 1n;
    messages.push({ index: 1030n, leaf: Fr.random(), l1BlockNumber: latestL1Block });

    expect(await rootFromPath(stalePath)).not.toEqual(await checkpointRoot(messages));
    expect(await rootFromPath(await buildInboxSiblingPath(inbox, DEPOSIT))).toEqual(await checkpointRoot(messages));
  });

  it('refuses the path if an L1 reorg replaces a message during the reads, and builds it again after the reorg', async () => {
    const readLogs = getMessageSentEvents.getMockImplementation()!;
    getMessageSentEvents.mockImplementationOnce((fromBlock, toBlock) => {
      messages = messages.map(m => (m.index === 1029n ? { ...m, leaf: Fr.random() } : m));
      return readLogs(fromBlock, toBlock);
    });

    await expect(buildInboxSiblingPath(inbox, DEPOSIT)).rejects.toStrictEqual(
      new Error(`The L1 Inbox logs up to L1 block ${LATEST_L1_BLOCK} do not give the Inbox root of checkpoint 2`),
    );
    expect(await rootFromPath(await buildInboxSiblingPath(inbox, DEPOSIT))).toEqual(await checkpointRoot(messages));
  });

  it('reads the L1 Inbox in pages of 10,000 blocks, from the first message of the checkpoint to the last', async () => {
    await buildInboxSiblingPath(inbox, DEPOSIT);

    expect(getMessageSentEvents.mock.calls).toEqual([
      [65_001n, 75_000n],
      [55_001n, 65_000n],
      [75_001n, 85_000n],
      [85_001n, 95_000n],
    ]);
  });

  it('proves the deposit message in a full checkpoint, with a message of the next checkpoint in the same read', async () => {
    for (let index = 1030n; index <= 2048n; index++) {
      messages.push({ index, leaf: Fr.random(), l1BlockNumber: 90_000n });
    }

    const path = await buildInboxSiblingPath(inbox, DEPOSIT);

    expect(await rootFromPath(path)).toEqual(await checkpointRoot(messages));
  });

  it('stops reading back at a message of the previous checkpoint', async () => {
    omittedFromLogs = [1024n];

    await expect(buildInboxSiblingPath(inbox, DEPOSIT)).rejects.toThrow();
    expect(getMessageSentEvents.mock.calls).toContainEqual([45_001n, 55_000n]);
    expect(getMessageSentEvents.mock.calls).not.toContainEqual([35_001n, 45_000n]);
  });

  it.each([
    ['the first message of the checkpoint', [1024n]],
    ['the deposit message', [1027n]],
    ['a message between the deposit message and the last message', [1028n]],
    ['the messages after the deposit message', [1028n, 1029n]],
  ])('refuses to build the path if the L1 Inbox logs do not have %s', async (_, omitted) => {
    omittedFromLogs = omitted;

    await expect(buildInboxSiblingPath(inbox, DEPOSIT)).rejects.toThrow(
      `The L1 Inbox logs up to L1 block ${LATEST_L1_BLOCK} do not give the Inbox root of checkpoint 2`,
    );
  });
});
