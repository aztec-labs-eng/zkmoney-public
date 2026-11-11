/** A rotation broadcast over records that do not read waits for a reload; it never fails or ends. */
import { describe, expect, it } from "vitest"
import { BroadcastDeferred, memoryBackend, type BroadcastJobOf } from "@obsidion/front-core"
import type { ObsidionWallet } from "@obsidion/sdk"
import { rotationExecutor } from "../../../src/features/broadcasts/rotationBroadcastExecutor"
import type { ExecutorSession } from "../../../src/session/session"
import { OWNER, SIPA, signedRecord, testRotations } from "../../support/backupAdd"

const job = {
  address: SIPA.toLowerCase(),
  source: { type: "rotation", owner: OWNER },
} as unknown as BroadcastJobOf<"rotation">

describe("the rotation executor over records that do not read", () => {
  it("defers the send rather than failing it", async () => {
    const backend = memoryBackend()
    backend.entries.set(
      `acct/backupRotations/${OWNER.toLowerCase()}`,
      JSON.stringify({ ...signedRecord(), phase: "typo" }),
    )
    const executor = rotationExecutor(
      {} as ObsidionWallet,
      {
        backupRotations: testRotations(backend),
      } as ExecutorSession,
    )
    const attempt = { onTxHash: async () => {} }
    await expect(executor.send(job, attempt)).rejects.toBeInstanceOf(BroadcastDeferred)
  })
})
