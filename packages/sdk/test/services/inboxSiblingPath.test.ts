import { describe, expect, it } from "vitest"

// Fake-based boundary test: the inbox/event source is faked, no live chain. The expected path is
// computed with the same tree utilities over the full leaf set.

import { L1_TO_L2_MSG_SUBTREE_HEIGHT } from "@aztec/constants"
import { Fr } from "@aztec/aztec.js/fields"
import { MerkleTreeCalculator, shaMerkleHash } from "@aztec/foundation/trees"
import {
  buildInboxSiblingPath,
  buildInboxSiblingPathHex,
} from "../../src/services/inboxSiblingPath.js"

const SUBTREE_SIZE = 1n << BigInt(L1_TO_L2_MSG_SUBTREE_HEIGHT)

type FakeEvent = {
  blockNumber: bigint
  args: { index: bigint; checkpointNumber: bigint; leaf?: unknown; hash?: unknown }
}

function makeEvents(checkpoint: bigint, count: number, startBlock: bigint): FakeEvent[] {
  const base = (checkpoint - 1n) * SUBTREE_SIZE
  return Array.from({ length: count }, (_, i) => ({
    blockNumber: startBlock + BigInt(i),
    args: {
      index: base + BigInt(i),
      checkpointNumber: checkpoint,
      leaf: new Fr(1000n + BigInt(i)),
    },
  }))
}

function fakeInbox(events: FakeEvent[], tip: bigint) {
  const calls: Array<[bigint, bigint]> = []
  return {
    calls,
    client: { getBlockNumber: async () => tip },
    getMessageSentEvents: async (fromBlock: bigint, toBlock: bigint) => {
      calls.push([fromBlock, toBlock])
      return events.filter((e) => e.blockNumber >= fromBlock && e.blockNumber <= toBlock)
    },
  }
}

async function expectedPath(leaves: Fr[], subtreeIndex: number): Promise<Fr[]> {
  const calculator = await MerkleTreeCalculator.create(
    L1_TO_L2_MSG_SUBTREE_HEIGHT,
    undefined,
    (l, r) => Promise.resolve(shaMerkleHash(l, r)),
  )
  const tree = await calculator.computeTree(leaves.map((f) => f.toBuffer()))
  return tree.getSiblingPath(subtreeIndex).map((buf: Buffer) => Fr.fromBuffer(buf))
}

// Checkpoint 3 → nonzero global index base, catches per-checkpoint vs global index confusion.
const CHECKPOINT = 3n
const BASE = (CHECKPOINT - 1n) * SUBTREE_SIZE

describe("buildInboxSiblingPath", () => {
  it("builds the path for a known leaf (matches independently-computed subtree)", async () => {
    const events = makeEvents(CHECKPOINT, 4, 100n)
    const inbox = fakeInbox(events, 200n)
    const path = await buildInboxSiblingPath(inbox, BASE + 2n)
    const expected = await expectedPath(
      events.map((e) => e.args.leaf as Fr),
      2,
    )
    expect(path.map((f) => f.toString())).toEqual(expected.map((f) => f.toString()))

    const hex = await buildInboxSiblingPathHex(fakeInbox(events, 200n), BASE + 2n)
    expect(hex).toEqual(expected.map((f) => f.toString()))
    for (const h of hex) expect(h).toMatch(/^0x[0-9a-f]+$/i)
  })

  it("bounded scan widens below the anchor to cover the checkpoint's earlier leaves", async () => {
    const events = makeEvents(CHECKPOINT, 4, 100n) // blocks 100..103
    const inbox = fakeInbox(events, 200n)
    // Anchor at the last leaf's block (the sweep's block); widening must reach back to block 100.
    const path = await buildInboxSiblingPath(inbox, BASE + 3n, {
      anchorBlock: 103n,
      widenBlocks: 50n,
    })
    expect(inbox.calls).toEqual([[53n, 200n]])
    const expected = await expectedPath(
      events.map((e) => e.args.leaf as Fr),
      3,
    )
    expect(path.map((f) => f.toString())).toEqual(expected.map((f) => f.toString()))
  })

  it("retries from genesis when the bounded window misses the subtree front", async () => {
    const events = makeEvents(CHECKPOINT, 4, 10n) // blocks 10..13, far below the window
    const inbox = fakeInbox(events, 500n)
    const path = await buildInboxSiblingPath(inbox, BASE + 1n, {
      anchorBlock: 490n,
      widenBlocks: 50n,
    })
    expect(inbox.calls.map(([from]) => from)).toEqual([440n, 0n])
    const expected = await expectedPath(
      events.map((e) => e.args.leaf as Fr),
      1,
    )
    expect(path.map((f) => f.toString())).toEqual(expected.map((f) => f.toString()))
  })

  it("throws a clear error when the leaf is missing", async () => {
    const inbox = fakeInbox(makeEvents(CHECKPOINT, 4, 100n), 200n)
    // Leaf index in a different (empty) checkpoint.
    await expect(buildInboxSiblingPath(inbox, 9n * SUBTREE_SIZE)).rejects.toThrow(
      /not found|incomplete/,
    )
  })

  it("throws when the subtree front is missing even at genesis (misaligned positions)", async () => {
    const events = makeEvents(CHECKPOINT, 4, 100n).slice(1) // first leaf of the checkpoint lost
    const inbox = fakeInbox(events, 200n)
    await expect(buildInboxSiblingPath(inbox, BASE + 2n)).rejects.toThrow(/not found|incomplete/)
  })

  it("tolerates both `leaf` and `hash` event field shapes", async () => {
    const leafEvents = makeEvents(CHECKPOINT, 4, 100n)
    const hashEvents = leafEvents.map((e) => ({
      blockNumber: e.blockNumber,
      args: {
        index: e.args.index,
        checkpointNumber: e.args.checkpointNumber,
        hash: (e.args.leaf as Fr).toString(), // hex string shape
      },
    }))
    const fromLeaf = await buildInboxSiblingPath(fakeInbox(leafEvents, 200n), BASE + 2n)
    const fromHash = await buildInboxSiblingPath(fakeInbox(hashEvents, 200n), BASE + 2n)
    expect(fromHash.map((f) => f.toString())).toEqual(fromLeaf.map((f) => f.toString()))
  })
})
