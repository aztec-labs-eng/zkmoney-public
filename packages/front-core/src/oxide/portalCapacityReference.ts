/**
 * The capacity store's reference: the L1 chain an Aztec node follows and the latest L1 time it has synced. The chain
 * has reached at least that time, so a capacity RPC whose block is far older is behind, whatever this device's clock
 * says. A failed node read rejects, which the store reports as unavailable.
 */
import type { AztecNode } from "@aztec/stdlib/interfaces/client"

type ReferenceNode = Pick<AztecNode, "getChainId" | "getSyncedL1Timestamp">

/** `pickNode` is asked on every call, so the node can change (pre-boot fallback to the booted node). */
export function nodeCapacityReference(
  pickNode: () => ReferenceNode,
): () => Promise<{ l1ChainId: number; l1Timestamp: bigint | undefined }> {
  // A node's L1 chain never changes, so only an answer is kept, one per node client. A lookup that
  // fails or never answers is not shared, so the next read (and the store's Retry) asks again.
  // `getChainId`, not `getNodeInfo`: the SDK's node client holds one `getNodeInfo` request for minutes.
  const chainIds = new WeakMap<ReferenceNode, number>()
  const chainIdOf = async (node: ReferenceNode) => {
    const cached = chainIds.get(node)
    if (cached !== undefined) return cached
    const l1ChainId = await node.getChainId()
    chainIds.set(node, l1ChainId)
    return l1ChainId
  }
  return async () => {
    const node = pickNode()
    const [l1ChainId, l1Timestamp] = await Promise.all([
      chainIdOf(node),
      node.getSyncedL1Timestamp(),
    ])
    return { l1ChainId, l1Timestamp }
  }
}
