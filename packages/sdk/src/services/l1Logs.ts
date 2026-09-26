import type { Address, PublicClient } from "viem"

/** Per-`getLogs` chunk. 10k is the ceiling public RPCs converge on; over it they reject outright. */
export const L1_LOG_RANGE_BLOCKS = 10_000n

/**
 * `getContractEvents` over an explicit window, split into chunks an RPC serves. The window is the
 * caller's: how far back a scan must reach is a completeness decision, and each reader owns its
 * own. This owns the chunking alone.
 */
export async function chunkedContractEvents(
  publicClient: PublicClient,
  request: { address: Address; abi: unknown; eventName: string; args?: unknown },
  fromBlock: bigint,
  toBlock: bigint,
): Promise<unknown[]> {
  const logs: unknown[] = []
  for (let from = fromBlock; from <= toBlock; from += L1_LOG_RANGE_BLOCKS) {
    const chunkEnd = from + L1_LOG_RANGE_BLOCKS - 1n
    logs.push(
      ...((await publicClient.getContractEvents({
        ...request,
        fromBlock: from,
        toBlock: chunkEnd < toBlock ? chunkEnd : toBlock,
      } as never)) as unknown[]),
    )
  }
  return logs
}
