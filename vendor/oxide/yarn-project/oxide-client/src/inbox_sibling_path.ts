import { Fr } from '@aztec/aztec.js/fields';
import { L1_TO_L2_MSG_SUBTREE_HEIGHT } from '@aztec/constants';
import type { InboxContract } from '@aztec/ethereum/contracts';
import { MerkleTreeCalculator, shaMerkleHash } from '@aztec/foundation/trees';

const SUBTREE_SIZE = 1n << BigInt(L1_TO_L2_MSG_SUBTREE_HEIGHT);

/** L1 blocks per `MessageSent` read. Public RPC nodes refuse a log read over a larger block range. */
const L1_LOG_PAGE = 10_000n;

export type InboxMessageSource = Pick<InboxContract, 'getMessageSentEvents' | 'getContract'> & {
  client: Pick<InboxContract['client'], 'getBlockNumber'>;
};

/**
 * The Inbox root of an open checkpoint changes with each new message. A new message or an L1 reorg after the reads
 * makes the portal refuse the path. Build the path again to retry.
 */
export async function buildInboxSiblingPath(
  inbox: InboxMessageSource,
  deposit: { messageLeafIndex: bigint; l1BlockNumber: bigint },
): Promise<Fr[]> {
  const firstIndex = deposit.messageLeafIndex - (deposit.messageLeafIndex % SUBTREE_SIZE);
  const endIndex = firstIndex + SUBTREE_SIZE;
  const checkpoint = firstIndex / SUBTREE_SIZE + 1n;
  const latest = await inbox.client.getBlockNumber();
  // At the last block that the reads cover, so that a later message does not change the root.
  const root = Fr.fromHexString(
    await inbox.getContract().read.getRoot([checkpoint], { blockNumber: latest }),
  ).toBuffer();

  const leaves = new Map<bigint, Buffer>();
  const read = async (fromBlock: bigint, toBlock: bigint): Promise<bigint[]> => {
    const logs = await inbox.getMessageSentEvents(fromBlock, toBlock);
    for (const { args } of logs) {
      if (args.index >= firstIndex && args.index < endIndex) {
        leaves.set(args.index, args.leaf.toBuffer());
      }
    }
    return logs.map(log => log.args.index);
  };
  const calculator = await MerkleTreeCalculator.create(L1_TO_L2_MSG_SUBTREE_HEIGHT, undefined, (left, right) =>
    Promise.resolve(shaMerkleHash(left, right)),
  );
  const buildTree = () => {
    const ordered: Buffer[] = [];
    for (let index = firstIndex; leaves.has(index); index++) {
      ordered.push(leaves.get(index)!);
    }
    return calculator.computeTree(ordered);
  };

  for (let toBlock = deposit.l1BlockNumber; toBlock >= 0n && !leaves.has(firstIndex); toBlock -= L1_LOG_PAGE) {
    const indexes = await read(toBlock < L1_LOG_PAGE ? 0n : toBlock - L1_LOG_PAGE + 1n, toBlock);
    if (indexes.some(index => index < firstIndex)) {
      break;
    }
  }
  let tree = await buildTree();
  for (
    let fromBlock = deposit.l1BlockNumber + 1n;
    fromBlock <= latest && !tree.root.equals(root);
    fromBlock += L1_LOG_PAGE
  ) {
    await read(fromBlock, fromBlock + L1_LOG_PAGE - 1n < latest ? fromBlock + L1_LOG_PAGE - 1n : latest);
    tree = await buildTree();
  }
  if (!tree.root.equals(root)) {
    throw new Error(
      `The L1 Inbox logs up to L1 block ${latest} do not give the Inbox root of checkpoint ${checkpoint}`,
    );
  }
  return tree.getSiblingPath(Number(deposit.messageLeafIndex - firstIndex)).map(node => Fr.fromBuffer(node));
}
