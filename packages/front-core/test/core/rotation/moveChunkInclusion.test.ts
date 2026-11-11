// @vitest-environment node
/**
 * A move chunk's block is saved as soon as its send resolves and kept once it is checkpointed:
 * Home counts the chunk as still to move until a balance read holds that block.
 */
import { TxStatus } from "@aztec-labs/stdlib/tx"
import type { TxHashCallback } from "@obsidion/sdk"
import { describe, expect, it, vi } from "vitest"
import { moveRotation } from "../../../src/core/rotation/backupRotationFlow"
import { OWNER, signedRecord, word } from "../../__test-helpers__/backupRotation"
import { harness, receipt } from "./rotationFlowHarness"

const HASH = word(0x301)

describe("a move chunk's block", () => {
  it.each([
    [TxStatus.PROPOSED, "included"],
    [TxStatus.CHECKPOINTED, "mined"],
  ] as const)("is saved when its send resolves at %s", async (status, state) => {
    const { deps, store, world } = harness()
    deps.move.send = vi.fn(async (_t: string, _a: bigint, onTxHash: TxHashCallback) => {
      await onTxHash(HASH, { expiresAtMs: 5000 })
      world.receipts.set(HASH, receipt(status, false, 77))
    })
    await store.put(signedRecord("rerooted"))
    const sent = await moveRotation(deps, (await store.get(OWNER))!)
    expect(sent.record.move?.runs[0]?.chunks[0]).toMatchObject({
      state,
      txHash: HASH,
      inclusion: { blockNumber: 77 },
    })
  })

  it("is kept when a later read first finds the send checkpointed", async () => {
    const { deps, store, world } = harness()
    await store.put(signedRecord("rerooted"))
    const sent = await moveRotation(deps, (await store.get(OWNER))!)
    const hash = sent.record.move!.runs[0]!.chunks[0]!.txHash!
    expect(sent.record.move?.runs[0]?.chunks[0]?.state).toBe("submitted")
    world.receipts.set(hash, receipt(TxStatus.CHECKPOINTED, false, 78))
    const read = await moveRotation(deps, sent.record)
    expect(read.record.move?.runs[0]?.chunks[0]).toMatchObject({
      state: "mined",
      inclusion: { blockNumber: 78 },
    })
  })
})
