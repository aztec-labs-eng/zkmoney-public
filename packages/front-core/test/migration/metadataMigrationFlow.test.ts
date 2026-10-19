import { describe, expect, it, vi } from "vitest"
import { ApprovalNeededError, StalePlanError } from "@obsidion/sdk"
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
    sent: false,
    complete: false,
  }
  const persist = vi.fn(async (record: MetadataMigrationRecord) => {
    stored = JSON.parse(JSON.stringify(record))
  })
  const steps: MetadataMigrationSteps = {
    binding: vi.fn(async () => "bound-deployments"),
    prepare: vi.fn(async () => "signed-plan"),
    ready: vi.fn(async () => {}),
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
  const drive = (opts?: { start?: boolean; signal?: AbortSignal; observeOnly?: boolean }) =>
    advanceMetadataMigration(stored, steps, persist, opts)
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
    expect(steps.recoverRemaining).toHaveBeenCalledWith("signed-plan", true, undefined)
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
    expect(steps.recoverRemaining).toHaveBeenCalledWith("signed-plan", false, undefined)
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

  it("prepares a stale unpublished plan again on the next attempt", async () => {
    const { steps, drive, stored } = fixture()
    const submit = steps.broadcast
    steps.broadcast = vi.fn(async () => {
      throw new StalePlanError("Destination metadata changed")
    })
    await drive()
    expect(stored()).toMatchObject({ phase: "needsAttention", plan: "signed-plan", stale: true })
    expect(stored().bootstrapTx).toBeUndefined()
    steps.broadcast = submit
    await drive()
    expect(steps.prepare).toHaveBeenCalledTimes(2)
    expect(stored().bootstrapTx).toBe("bootstrap-hash")
  })

  it("keeps an unpublished plan through any other stop and rebuilds it on the user's next start", async () => {
    const { steps, drive, stored } = fixture()
    const submit = steps.broadcast
    steps.broadcast = vi.fn(async () => {
      throw new Error("node unreachable")
    })
    await drive({ start: true })
    expect(stored()).toMatchObject({ phase: "needsAttention", plan: "signed-plan" })
    expect(stored().stale).toBeUndefined()
    steps.broadcast = submit
    await drive({ start: true })
    expect(steps.prepare).toHaveBeenCalledTimes(1)
    expect(steps.ready).toHaveBeenCalledWith("signed-plan", undefined, false, expect.any(Function))
    expect(stored().bootstrapTx).toBe("bootstrap-hash")
  })

  it("resumes an interrupted preparation from the draft it saved", async () => {
    const { steps, drive, stored } = fixture()
    steps.prepare = vi.fn(async (draft, saveDraft) => {
      if (draft) return "signed-plan"
      await saveDraft("coordinates")
      throw new DOMException("The operation either timed out or was not allowed", "NotAllowedError")
    })
    await drive({ start: true })
    expect(stored()).toMatchObject({
      phase: "needsAttention",
      draft: "coordinates",
      refused: true,
    })
    expect(stored().plan).toBeUndefined()
    await drive({ start: true })
    expect(steps.prepare).toHaveBeenLastCalledWith(
      "coordinates",
      expect.any(Function),
      undefined,
      expect.any(Function),
    )
    expect(stored().draft).toBeUndefined()
    expect(stored().bootstrapTx).toBe("bootstrap-hash")
  })

  it("publishes nothing when cancelled during preparation, and keeps its draft", async () => {
    const { steps, drive, stored } = fixture()
    const cancel = new AbortController()
    steps.prepare = vi.fn(async (_draft, saveDraft, signal) => {
      await saveDraft("coordinates")
      cancel.abort()
      signal!.throwIfAborted()
      return "signed-plan"
    })
    await drive({ start: true, signal: cancel.signal })
    expect(steps.broadcast).not.toHaveBeenCalled()
    expect(stored()).toMatchObject({ phase: "preparing", draft: "coordinates" })
    expect(stored().error).toBeUndefined()
  })

  it("publishes nothing when cancelled during the final proof", async () => {
    const { steps, drive, stored } = fixture()
    const cancel = new AbortController()
    steps.prepare = vi.fn(async (_draft, saveDraft) => {
      await saveDraft("coordinates")
      cancel.abort()
      return "signed-plan"
    })
    await drive({ start: true, signal: cancel.signal })
    expect(steps.broadcast).not.toHaveBeenCalled()
    expect(stored().plan).toBeUndefined()
    expect(stored().draft).toBe("coordinates")
  })

  it("publishes nothing when closed while a saved plan is rebuilt", async () => {
    const { steps, drive, stored } = fixture()
    steps.broadcast = vi.fn(async () => {
      throw new Error("node unreachable")
    })
    await drive({ start: true })
    const cancel = new AbortController()
    steps.broadcast = vi.fn(async () => {})
    steps.ready = vi.fn(async () => {
      cancel.abort()
    })
    await drive({ start: true, signal: cancel.signal })
    expect(steps.broadcast).not.toHaveBeenCalled()
    expect(stored().phase).toBe("needsAttention")
  })

  it("publishes nothing when closed while the chain is observed before publication", async () => {
    const { steps, drive, stored } = fixture()
    const cancel = new AbortController()
    steps.observe = vi.fn(async () => {
      cancel.abort()
      return {
        bootstrapSpent: false,
        metadataSettled: false,
        messagesReady: false,
        recurringSponsorship: false,
        sent: false,
        complete: false,
      }
    })
    await drive({ start: true, signal: cancel.signal })
    expect(steps.broadcast).not.toHaveBeenCalled()
    expect(stored().bootstrapTx).toBeUndefined()
  })

  it("submits nothing when closed while the publication is proven", async () => {
    const { steps, drive, stored } = fixture()
    const cancel = new AbortController()
    const submitted = vi.fn()
    steps.broadcast = vi.fn(async (_plan, onTxHash) => {
      cancel.abort()
      await onTxHash("proven-hash")
      submitted()
    })
    await drive({ start: true, signal: cancel.signal })
    expect(submitted).not.toHaveBeenCalled()
    expect(stored().bootstrapTx).toBeUndefined()
    expect(stored().phase).not.toBe("needsAttention")
  })

  it("reads as arriving once every planned batch is sent", async () => {
    const { drive, steps, observed, stored } = fixture()
    observed.metadataSettled = true
    observed.recurringSponsorship = true
    await drive()
    expect(stored().phase).toBe("recovering")
    observed.sent = true
    await drive()
    expect(stored().phase).toBe("arriving")
    expect(steps.recoverRemaining).toHaveBeenCalledTimes(2)
  })

  it("observes a run the user did not start without preparing, signing or sending", async () => {
    const { drive, steps, observed, stored } = fixture()
    steps.reconcileRemaining = vi.fn(async () => {})
    await drive({ observeOnly: true })
    expect(steps.prepare).not.toHaveBeenCalled()
    await drive()
    vi.mocked(steps.broadcast).mockClear()
    observed.messagesReady = true
    await drive({ observeOnly: true })
    expect(steps.subscribe).not.toHaveBeenCalled()
    observed.metadataSettled = true
    observed.recurringSponsorship = true
    await drive({ observeOnly: true })
    expect(stored().phase).toBe("recovering")
    observed.sent = true
    await drive({ observeOnly: true })
    expect(stored().phase).toBe("arriving")
    expect(steps.reconcileRemaining).toHaveBeenCalledWith("signed-plan")
    expect(steps.recoverRemaining).not.toHaveBeenCalled()
    expect(steps.broadcast).not.toHaveBeenCalled()
  })

  it("stops for the user's approval instead of prompting from a background pass", async () => {
    const { drive, steps, observed, stored } = fixture()
    observed.metadataSettled = true
    observed.recurringSponsorship = true
    steps.recoverRemaining = vi.fn(async () => {
      throw new ApprovalNeededError()
    })
    await drive()
    expect(stored()).toMatchObject({ phase: "needsApproval", plan: "signed-plan" })
  })

  it("saves how many batch approvals preparing has collected", async () => {
    const { drive, steps, stored } = fixture()
    steps.prepare = vi.fn(async (_draft, _save, _signal, onApproval) => {
      await onApproval!(1, 3)
      return "signed-plan"
    })
    await drive({ start: true })
    expect(stored().approvals).toEqual({ approved: 1, total: 3 })
  })

  it("runs the user's approve step on every start, published or not", async () => {
    const { drive, steps, observed } = fixture()
    await drive({ start: true })
    observed.bootstrapStatus = "included"
    observed.bootstrapSpent = true
    await drive({ start: true })
    expect(steps.ready).toHaveBeenCalledWith("signed-plan", undefined, true, expect.any(Function))
  })

  it("rebuilds a saved plan only on the user's own start", async () => {
    const { steps, drive } = fixture()
    steps.broadcast = vi.fn(async () => {
      throw new Error("node unreachable")
    })
    await drive({ start: true })
    await drive()
    expect(steps.ready).not.toHaveBeenCalled()
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
      halt: "reverted",
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
