import { describe, expect, it, vi } from "vitest"
import { fundRotation, publishRotation } from "../../../src/core/rotation/backupRotationFlow"
import { OWNER, signedRecord } from "../../__test-helpers__/backupRotation"
import { harness } from "./rotationFlowHarness"

describe("the checks before a publish or a funding", () => {
  const steps = [
    ["signed", publishRotation],
    ["published", fundRotation],
  ] as const

  it("parks a superseded change without asking the route, whose quote fails", async () => {
    for (const [phase, step] of steps) {
      const { deps, store, world } = harness()
      ;(deps.fundability as ReturnType<typeof vi.fn>).mockResolvedValue("superseded")
      ;(deps.route as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("the sweep reverts"))
      await store.put(signedRecord(phase))
      expect((await step(deps, (await store.get(OWNER))!)).record).toMatchObject({
        phase: "created",
        rotation: undefined,
      })
      world.balance = 500n
      await store.put(signedRecord(phase))
      expect((await step(deps, (await store.get(OWNER))!)).record).toMatchObject({
        phase: "attention",
        attention: "stranded",
        suspended: phase,
      })
      expect(deps.route).not.toHaveBeenCalled()
      expect(deps.publish).not.toHaveBeenCalled()
      expect(deps.fund).not.toHaveBeenCalled()
    }
  })

  it("publishes and funds nothing on a fundability verdict it does not know", async () => {
    for (const [phase, step] of steps) {
      const { deps, store } = harness()
      ;(deps.fundability as ReturnType<typeof vi.fn>).mockResolvedValue("retired")
      await store.put(signedRecord(phase))
      await expect(step(deps, (await store.get(OWNER))!)).rejects.toMatchObject({
        code: "invariant",
      })
      expect(deps.publish).not.toHaveBeenCalled()
      expect(deps.fund).not.toHaveBeenCalled()
    }
  })
})
