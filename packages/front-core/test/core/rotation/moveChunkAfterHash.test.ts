// @vitest-environment node
/** A move chunk whose send failed after the node took its hash. */
import type { TxHashCallback } from "@obsidion/sdk"
import { describe, expect, it, vi } from "vitest"
import { moveRotation, type RotationFlowDeps } from "../../../src/core/rotation/backupRotationFlow"
import { createBackupRotations } from "../../../src/engine/backupRotations"
import { openDatabase } from "../../../src/engine/database"
import { memoryBackend } from "../../../src/engine/memoryBackend"
import { OWNER, signedRecord, word } from "../../__test-helpers__/backupRotation"

const DAI = 10n ** 18n
const NODE_DOWN = new Error("node down")

/** The deps a move from `rerooted` reads; `send` takes its hash, then fails. */
function moveDeps() {
  const store = createBackupRotations({ db: openDatabase(memoryBackend()) })
  const send = vi.fn(async (_token: string, _amount: bigint, onTxHash: TxHashCallback) => {
    await onTxHash(word(0x101), { expiresAtMs: 5000 })
    throw NODE_DOWN
  })
  const deps = {
    store,
    now: () => 2000,
    mintAttemptId: () => "send-1",
    session: "life-1",
    move: {
      tokens: async () => ["tok"],
      shape: async () => ({ notes: [DAI], depositTotal: 0n, balance: DAI }),
      deposits: async () => ({ kind: "exact" as const, amounts: [] }),
      cap: async () => 2n * DAI,
      usesLeft: async () => true,
      links: async () => [],
      send,
      declined: () => false,
    },
  } as unknown as RotationFlowDeps
  return { deps, store, send }
}

describe("a move chunk whose send fails after its hash", () => {
  it("keeps the chunk submitted under that hash, and hands the failure to the caller", async () => {
    const { deps, store, send } = moveDeps()
    await store.put(signedRecord("rerooted"))
    await expect(moveRotation(deps, (await store.get(OWNER))!)).rejects.toBe(NODE_DOWN)
    expect(send).toHaveBeenCalledTimes(1)
    expect((await store.get(OWNER))?.move?.runs[0]?.chunks[0]).toMatchObject({
      state: "submitted",
      txHash: word(0x101),
    })
    expect((await store.get(OWNER))?.move?.runs[0]?.chunks[0]?.claim).toBeUndefined()
  })
})
