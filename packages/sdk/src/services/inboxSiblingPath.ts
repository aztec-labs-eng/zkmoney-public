/**
 * L1 inbox membership path for the unprocessed-deposit exit (`refundUnprocessedDeposit`): read the
 * deposit checkpoint's `MessageSent` leaves off the Inbox and rebuild the sha subtree. Pin-tolerant:
 * the leaf field is `leaf` or `hash` (Fr or hex). The scan anchors on a caller-supplied L1 block
 * (e.g. the sweep's block) widened by `widenBlocks` to reach the checkpoint's earlier leaves; a miss
 * or incomplete subtree retries from genesis, then throws — upstream classifies that as transient,
 * never benign.
 */
import { L1_TO_L2_MSG_SUBTREE_HEIGHT } from "@aztec/constants"
import { Fr } from "@aztec/aztec.js/fields"
import { MerkleTreeCalculator, shaMerkleHash } from "@aztec/foundation/trees"

const SUBTREE_SIZE = 1n << BigInt(L1_TO_L2_MSG_SUBTREE_HEIGHT)
// ponytail: ~2 weeks of L1 blocks; the genesis retry backstops an insufficient default.
const DEFAULT_WIDEN_BLOCKS = 100_000n

/** Minimal Inbox surface — `InboxContract` at the portal's `INBOX()` satisfies it; tests pass fakes. */
export interface InboxMessageSource {
  client: { getBlockNumber(): Promise<bigint | number> }
  getMessageSentEvents(fromBlock: bigint, toBlock: bigint): Promise<InboxMessageSentLog[]>
}

export interface InboxMessageSentLog {
  args: { index: bigint; checkpointNumber: bigint | number; leaf?: unknown; hash?: unknown }
}

export interface InboxSiblingPathOptions {
  /** L1 block anchoring the bounded scan (e.g. the sweep's block). Absent → genesis scan. */
  anchorBlock?: bigint
  widenBlocks?: bigint
}

export async function buildInboxSiblingPath(
  inbox: InboxMessageSource,
  messageLeafIndex: bigint,
  opts: InboxSiblingPathOptions = {},
): Promise<Fr[]> {
  const subtreeIndex = Number(messageLeafIndex % SUBTREE_SIZE)
  const checkpointNumber = messageLeafIndex / SUBTREE_SIZE + 1n
  const checkpointBase = (checkpointNumber - 1n) * SUBTREE_SIZE

  const tip = BigInt(await inbox.client.getBlockNumber())
  const widen = opts.widenBlocks ?? DEFAULT_WIDEN_BLOCKS
  const anchoredFrom =
    opts.anchorBlock !== undefined && opts.anchorBlock > widen ? opts.anchorBlock - widen : 0n
  // Bounded first, genesis retry on a miss — a subtree missing its front misaligns leaf positions.
  const fromBlocks = anchoredFrom > 0n ? [anchoredFrom, 0n] : [0n]

  for (const fromBlock of fromBlocks) {
    const logs = (await inbox.getMessageSentEvents(fromBlock, tip))
      .filter((log) => BigInt(log.args.checkpointNumber) === checkpointNumber)
      .sort((a, b) => Number(a.args.index - b.args.index))
    const indices = logs.map((log) => log.args.index)
    const complete =
      indices.includes(messageLeafIndex) &&
      indices.every((idx, i) => idx === checkpointBase + BigInt(i))
    if (!complete) continue

    const leaves = logs.map((log) => {
      const leaf = log.args.leaf ?? log.args.hash
      return (typeof leaf === "string" ? Fr.fromString(leaf) : (leaf as Fr)).toBuffer()
    })
    const calculator = await MerkleTreeCalculator.create(
      L1_TO_L2_MSG_SUBTREE_HEIGHT,
      undefined,
      (l, r) => Promise.resolve(shaMerkleHash(l, r)),
    )
    const tree = await calculator.computeTree(leaves)
    return tree.getSiblingPath(subtreeIndex).map((buf: Buffer) => Fr.fromBuffer(buf))
  }

  throw new Error(
    `Inbox MessageSent leaf ${messageLeafIndex} (checkpoint ${checkpointNumber}) not found or subtree incomplete after genesis scan to L1 block ${tip}`,
  )
}

/** Hex form for callers across the frozen-realm seam (the far side re-mints Fr from hex). */
export async function buildInboxSiblingPathHex(
  inbox: InboxMessageSource,
  messageLeafIndex: bigint,
  opts?: InboxSiblingPathOptions,
): Promise<string[]> {
  return (await buildInboxSiblingPath(inbox, messageLeafIndex, opts)).map((f) => f.toString())
}
