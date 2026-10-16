import { describe, expect, it, vi } from "vitest"
import {
  advanceMetadataMigration,
  newMetadataMigration,
  type MetadataMigrationObservation,
  type MetadataMigrationRecord,
  type MetadataMigrationSteps,
} from "../../src/core/migration/metadataMigrationFlow"

function fixture() {
  let stored = newMetadataMigration("migration", "bound-deployments")
  const observed: MetadataMigrationObservation = {
    bootstrapSpent: false,
    metadataSettled: false,
    messagesReady: false,
    recurringSponsorship: false,
    complete: false,
  }
  const persist = vi.fn(async (record: MetadataMigrationRecord) => {
    stored = JSON.parse(JSON.stringify(record))
  })
  const steps: MetadataMigrationSteps = {
    binding: vi.fn(async () => "bound-deployments"),
    prepare: vi.fn(async () => "signed-plan"),
    observe: vi.fn(async () => ({ ...observed })),
    broadcast: vi.fn(async (_plan, onTxHash) => {
      await onTxHash("bootstrap-hash")
      expect(stored.bootstrapTx).toBe("bootstrap-hash")
    }),
    fund: vi.fn(async () => {}),
    subscribe: vi.fn(async (_plan, onTxHash) => {
      await onTxHash("subscription-hash")
      expect(stored.subscriptionTx).toBe("subscription-hash")
    }),
    recoverRemaining: vi.fn(async () => {}),
  }
  const drive = () => advanceMetadataMigration(stored, steps, persist)
  return { steps, observed, persist, drive, stored: () => stored }
}

describe("shared metadata migration", () => {
  it("resumes through both message waits and sponsorship before recovering the remainder", async () => {
    const { drive, steps, observed, stored } = fixture()
    await drive()
    expect(steps.broadcast).toHaveBeenCalledTimes(1)
    await drive() // Restart while the submission result is unknown.
    expect(steps.broadcast).toHaveBeenCalledTimes(1)
    observed.bootstrapStatus = "included"
    observed.bootstrapSpent = true
    await drive()
    expect(stored().phase).toBe("awaitingMessages")
    expect(steps.recoverRemaining).not.toHaveBeenCalled()
    observed.metadataSettled = true
    observed.messagesReady = true
    await drive()
    expect(steps.subscribe).toHaveBeenCalledTimes(1)
    await drive() // Restart after sending the subscription, before its receipt.
    expect(steps.subscribe).toHaveBeenCalledTimes(1)
    observed.subscriptionStatus = "included"
    observed.recurringSponsorship = true
    await drive()
    expect(steps.recoverRemaining).toHaveBeenCalledWith("signed-plan", true)
    observed.complete = true
    await drive()
    expect(stored().phase).toBe("done")
    expect(steps.prepare).toHaveBeenCalledTimes(1)
  })

  it("recovers without a bootstrap when the destination record is already current", async () => {
    const { drive, steps, observed, stored } = fixture()
    observed.metadataSettled = true
    observed.recurringSponsorship = true
    await drive()
    expect(steps.broadcast).not.toHaveBeenCalled()
    expect(steps.recoverRemaining).toHaveBeenCalledWith("signed-plan", false)
    expect(stored().phase).toBe("recovering")
    observed.complete = true
    await drive()
    expect(stored().phase).toBe("done")
  })

  it("recovers funds that reach the source after the migration completed", async () => {
    const { drive, steps, observed, stored } = fixture()
    observed.metadataSettled = true
    observed.recurringSponsorship = true
    observed.complete = true
    await drive()
    expect(stored().phase).toBe("done")
    observed.complete = false
    await drive()
    expect(steps.recoverRemaining).toHaveBeenCalledOnce()
    expect(stored().phase).toBe("recovering")
    expect(steps.prepare).toHaveBeenCalledOnce()
  })

  it("reprepares a rejected unpublished plan on the next authorized attempt", async () => {
    const { steps, drive, stored } = fixture()
    const submit = steps.broadcast
    steps.broadcast = vi.fn(async () => {
      throw new Error("Destination metadata changed")
    })
    await drive()
    expect(stored()).toMatchObject({ phase: "needsAttention", plan: "signed-plan" })
    expect(stored().bootstrapTx).toBeUndefined()
    steps.broadcast = submit
    await drive()
    expect(steps.prepare).toHaveBeenCalledTimes(2)
    expect(stored().bootstrapTx).toBe("bootstrap-hash")
  })

  it("does not retry a submission whose RPC response was lost", async () => {
    const { steps, drive, stored } = fixture()
    steps.broadcast = vi.fn(async (_plan, onTxHash) => {
      await onTxHash("possibly-submitted")
      throw new Error("connection lost")
    })
    await drive()
    expect(stored().bootstrapTx).toBe("possibly-submitted")
    await drive()
    expect(steps.broadcast).toHaveBeenCalledTimes(1)
    expect(stored().phase).toBe("broadcasting")
  })

  it("retains an included public revert and the spent allowance", async () => {
    const { steps, drive, observed, stored } = fixture()
    await drive()
    observed.bootstrapStatus = "reverted"
    observed.bootstrapSpent = true
    await drive()
    await drive()
    expect(stored()).toMatchObject({
      phase: "needsAttention",
      allowance: "spent",
      bootstrapStatus: "reverted",
    })
    expect(steps.broadcast).toHaveBeenCalledTimes(1)
    expect(steps.fund).not.toHaveBeenCalled()
  })

  it("does not renew an allowance when the destination registry changes", async () => {
    const { drive, observed, steps, stored } = fixture()
    observed.bootstrapSpent = true
    await drive()
    expect(stored().error).toContain("does not renew")
    expect(steps.broadcast).not.toHaveBeenCalled()
  })

  it("uses an existing recurring subscription to publish the metadata update first", async () => {
    const { drive, observed, steps } = fixture()
    observed.bootstrapSpent = true
    observed.recurringSponsorship = true
    await drive()
    expect(steps.broadcast).toHaveBeenCalledTimes(1)
    expect(steps.recoverRemaining).not.toHaveBeenCalled()
  })

  it("reprepares only after a definitive drop and an unspent allowance", async () => {
    const { drive, observed, steps, stored } = fixture()
    await drive()
    observed.bootstrapStatus = "dropped"
    await drive()
    expect(stored().phase).toBe("preparing")
    observed.bootstrapStatus = undefined
    await drive()
    expect(steps.prepare).toHaveBeenCalledTimes(2)
    expect(steps.broadcast).toHaveBeenCalledTimes(2)
  })

  it("does not call source funding or a transaction when the account binding changed", async () => {
    const { drive, steps, stored } = fixture()
    steps.binding = vi.fn(async () => "different-account")
    await drive()
    expect(stored().phase).toBe("needsAttention")
    expect(steps.prepare).not.toHaveBeenCalled()
    expect(steps.broadcast).not.toHaveBeenCalled()
  })

  it("keeps the zero-old-funds flow waiting until metadata and the deposit reach the destination", async () => {
    const { drive, observed, stored } = fixture()
    await drive()
    observed.bootstrapStatus = "included"
    observed.bootstrapSpent = true
    observed.complete = true // No source units left is insufficient evidence of completion.
    await drive()
    expect(stored().phase).toBe("awaitingMessages")
  })
})
