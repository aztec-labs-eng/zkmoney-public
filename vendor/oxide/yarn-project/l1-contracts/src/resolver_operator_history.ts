import type { Address, PublicClient } from 'viem';

import type { ResolverOperatorArg } from './account_metadata_registry.js';
import { AccountMetadataRegistryAbi } from './artifacts.js';

export type HistoricalResolverOperator = {
  owner: Address;
  entry: ResolverOperatorArg;
  blockNumber: bigint;
  logIndex: number;
};

type BlockRange = { fromBlock: bigint; toBlock: bigint };

const CHUNK_BLOCKS = 10_000n;
const CHUNK_CONCURRENCY = 6;

/**
 * Reads complete operator entries, including entries that later writes replaced. It asks for the whole range in one
 * query. If the RPC refuses that query, it reads the range in chunks.
 */
export async function readResolverOperatorHistory(
  publicClient: PublicClient,
  registry: Address,
  range: BlockRange,
): Promise<HistoricalResolverOperator[]> {
  if (range.fromBlock > range.toBlock) {
    return [];
  }
  const read = (fromBlock: bigint, toBlock: bigint) =>
    publicClient.getContractEvents({
      address: registry,
      abi: AccountMetadataRegistryAbi,
      eventName: 'ResolverOperatorUpdated',
      fromBlock,
      toBlock,
      strict: true,
    });
  let logs: Awaited<ReturnType<typeof read>>;
  try {
    logs = await read(range.fromBlock, range.toBlock);
  } catch (err) {
    if (range.toBlock - range.fromBlock < CHUNK_BLOCKS) {
      throw err;
    }
    logs = (await readChunks(range, read)).flat();
  }

  const records: HistoricalResolverOperator[] = [];
  for (const log of logs) {
    if (log.removed) {
      continue;
    }
    if (log.blockNumber === null || log.logIndex === null) {
      throw new Error('Resolver operator history contains an unmined event');
    }
    records.push({
      owner: log.args.resolverOperator,
      entry: log.args.entry,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
    });
  }
  return records.sort((a, b) =>
    a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex,
  );
}

/** Reads each chunk of `range`, at most `CHUNK_CONCURRENCY` at a time, and returns the results in chunk order. */
async function readChunks<T>(
  range: BlockRange,
  read: (fromBlock: bigint, toBlock: bigint) => Promise<T>,
): Promise<T[]> {
  const chunks: BlockRange[] = [];
  for (let fromBlock = range.fromBlock; fromBlock <= range.toBlock; fromBlock += CHUNK_BLOCKS) {
    const end = fromBlock + CHUNK_BLOCKS - 1n;
    chunks.push({ fromBlock, toBlock: end < range.toBlock ? end : range.toBlock });
  }
  const results: T[] = new Array(chunks.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < chunks.length) {
      const index = next++;
      try {
        results[index] = await read(chunks[index].fromBlock, chunks[index].toBlock);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, chunks.length) }, worker));
  return results;
}
