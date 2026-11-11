import type { OxideEnvTuple } from "@obsidion/core/types"
import type { PublicClient } from "viem"
import { WalletError } from "../engine/errors"

type BlockReader = Pick<PublicClient, "getBlock">

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

/** The block a deployment's own transactions start at, as its manifest entry names it. */
export function deploymentStartBlock(
  tuple: Pick<OxideEnvTuple, "deployedAtBlock" | "portal">,
): bigint {
  if (tuple.deployedAtBlock === undefined)
    throw new WalletError(
      "config.invalid",
      `oxide manifest entry for portal ${tuple.portal} names no deployedAtBlock, so no scan can start at its deployment`,
    )
  return BigInt(tuple.deployedAtBlock)
}

/**
 * The L1 window that covers a deployment's whole life: from the block its own transactions start
 * at to the head. Every log scan about one deployment — its operator records, its sweeps, its
 * funding transfers — is complete inside this window and cannot be complete in a shorter one.
 */
export async function deploymentScanRange(
  publicClient: Pick<PublicClient, "getBlockNumber">,
  tuple: Pick<OxideEnvTuple, "deployedAtBlock" | "portal">,
  head?: bigint,
): Promise<{ fromBlock: bigint; toBlock: bigint }> {
  const start = deploymentStartBlock(tuple)
  const toBlock = head ?? (await publicClient.getBlockNumber({ cacheTime: 0 }))
  // An RPC behind the deployment has nothing about it below its head, so the window collapses onto
  // the head.
  return { fromBlock: start > toBlock ? toBlock : start, toBlock }
}
