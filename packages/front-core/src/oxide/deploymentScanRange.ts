import type { OxideEnvTuple } from "@obsidion/core/types"
import type { PublicClient } from "viem"

type BlockReader = Pick<PublicClient, "getBlock" | "getBlockNumber">

/**
 * Finds the first block at or after `timestampSec`, in whole seconds.
 * Returns `undefined` if the chain has not reached `timestampSec` yet.
 */
export async function findBlockAtTime(
  publicClient: BlockReader,
  timestampSec: number,
  head: bigint,
): Promise<bigint | undefined> {
  const target = BigInt(timestampSec)
  const headBlock = await publicClient.getBlock({ blockNumber: head })
  if (headBlock.timestamp < target) return undefined
  let low = 0n
  let high = head
  while (low < high) {
    const mid = (low + high) / 2n
    const { timestamp } = await publicClient.getBlock({ blockNumber: mid })
    if (timestamp >= target) high = mid
    else low = mid + 1n
  }
  return low
}

/**
 * Maps `chainId:deployedAtMs` to the block a deployment's scans start at.
 */
const deploymentStartBlocks = new Map<string, Promise<bigint | undefined>>()

/** Clears the cache - for testing only. */
export function resetDeploymentScanRangeForTests(): void {
  deploymentStartBlocks.clear()
}

/**
 * Only a found block keeps its entry. A failed read and a chain that has not reached the timestamp
 * are both statements about now, and an entry holding either would answer for the whole session.
 */
function cached(
  tuple: OxideEnvTuple,
  search: (deployedAtMs: number) => Promise<bigint | undefined>,
) {
  const deployedAtMs = Date.parse(tuple.deployedAt)
  const key = `${tuple.chainId ?? "?"}:${deployedAtMs}`
  const known = deploymentStartBlocks.get(key)
  if (known) return known

  const found = search(deployedAtMs)
    .then((block) => {
      if (block === undefined) deploymentStartBlocks.delete(key)
      return block
    })
    .catch((error) => {
      deploymentStartBlocks.delete(key)
      throw error
    })
  deploymentStartBlocks.set(key, found)
  return found
}

/**
 * The L1 window that covers a deployment's whole life: from the block its own transactions start
 * at to the head. Every log scan about one deployment — its operator records, its sweeps, its
 * funding transfers — is complete inside this window and cannot be complete in a shorter one.
 */
export async function deploymentScanRange(
  publicClient: BlockReader,
  tuple: OxideEnvTuple,
  head?: bigint,
): Promise<{ fromBlock: bigint; toBlock: bigint }> {
  const toBlock = head ?? (await publicClient.getBlockNumber({ cacheTime: 0 }))

  // If the deployment has a known block number, use it.
  const start =
    tuple.deployedAtBlock !== undefined
      ? BigInt(tuple.deployedAtBlock)
      : await cached(tuple, (deployedAtMs) =>
          findBlockAtTime(publicClient, Math.floor(deployedAtMs / 1000), toBlock),
        )

  // The deployment starts above the head — an RPC behind it, or a chain that has not reached
  // `deployedAt`. Either way nothing about it can be below the head, so the window collapses onto
  // the head.
  const fromBlock = start === undefined || start > toBlock ? toBlock : start

  return { fromBlock, toBlock }
}
