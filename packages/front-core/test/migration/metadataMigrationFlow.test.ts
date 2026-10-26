import { describe, expect, it, vi } from "vitest"
import { ApprovalNeededError, MigrationSubsidyNotReadyError, StalePlanError } from "@obsidion/sdk"
import { provingProgress } from "@obsidion/proving-progress"
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
    subscribe: vi.fn(async (_plan, onTxHash) => {
      await onTxHash("subscription-hash")
      expect(stored.subscriptionTx).toBe("subscription-hash")
    }),
    recoverRemaining: vi.fn(async () => {}),
  }
  const drive = (opts?: Parameters<typeof advanceMetadataMigration>[3]) =>
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
    expect(steps.recoverRemaining).toHaveBeenCalledWith(
      "signed-plan",
      undefined,
      expect.any(Function),
    )
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
    expect(steps.recoverRemaining).toHaveBeenCalledWith(
      "signed-plan",
      undefined,
      expect.any(Function),
    )
    expect(stored().phase).toBe("recovering")
    observed.complete = true
    await drive()
    expect(stored().phase).toBe("done")
  })

  it("records that funds may have left the source once a funds send starts", async () => {
    const { drive, steps, observed, stored } = fixture()
    observed.metadataSettled = true
    observed.recurringSponsorship = true
    await drive()
    expect(stored().fundsSent).toBeUndefined()
    vi.mocked(steps.recoverRemaining).mockImplementationOnce(async (_plan, _signal, gate) => {
      await gate!(async () => {
        throw new Error("receipt lost")
      }).catch(() => {})
    })
    await drive()
    expect(stored().fundsSent).toBe(true)
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

  it("is done only once the balance holds what the run imported, observed or driven", async () => {
    const { drive, steps, observed, stored } = fixture()
    let held = false
    steps.confirmBalance = vi.fn(async () => held)
    steps.reconcileRemaining = vi.fn(async () => {})
    observed.metadataSettled = true
    observed.recurringSponsorship = true
    observed.sent = true
    observed.complete = true
    await drive()
    expect(stored().phase).toBe("arriving")
    await drive({ observeOnly: true })
    expect(stored().phase).toBe("arriving")
    held = true
    await drive({ observeOnly: true })
    expect(stored().phase).toBe("done")
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
    expect(steps.reconcileRemaining).toHaveBeenCalledWith(
      "signed-plan",
      undefined,
      expect.any(Function),
    )
    expect(steps.recoverRemaining).not.toHaveBeenCalled()
    expect(steps.broadcast).not.toHaveBeenCalled()
  })

  it("waits, with no stop, for another run's registration before a funds-only run sends", async () => {
    const { drive, steps, observed, stored } = fixture()
    Object.assign(steps, { waitsForRegistration: true })
    await drive({ start: true })
    expect(stored()).toMatchObject({ phase: "waiting", plan: "signed-plan" })
    // The registration run spent the bootstrap allowance; its subscription is not there yet.
    observed.bootstrapSpent = true
    await drive({ promptless: true })
    expect(stored().phase).toBe("waiting")
    expect(stored().error).toBeUndefined()
    observed.metadataSettled = true
    await drive({ promptless: true })
    expect(stored().phase).toBe("waiting")
    expect(steps.broadcast).not.toHaveBeenCalled()
    expect(steps.subscribe).not.toHaveBeenCalled()
    expect(steps.recoverRemaining).not.toHaveBeenCalled()
    observed.recurringSponsorship = true
    await drive({ promptless: true })
    expect(stored().phase).toBe("recovering")
    expect(steps.recoverRemaining).toHaveBeenCalledWith(
      "signed-plan",
      undefined,
      expect.any(Function),
    )
  })

  it("waits for the migration subsidy with its reason, and goes on once it pays", async () => {
    const { drive, steps, observed, stored, persist } = fixture()
    observed.metadataSettled = true
    observed.recurringSponsorship = true
    const notReady = new MigrationSubsidyNotReadyError(["price feed is stale"])
    steps.recoverRemaining = vi.fn(async () => {
      throw notReady
    })
    await drive()
    expect(stored()).toMatchObject({ phase: "waiting", waitReason: notReady.message })
    expect(stored().error).toBeUndefined()
    // Each pass keeps the reason: the run does not read as sending between them.
    persist.mockClear()
    await drive({ promptless: true })
    expect(persist.mock.calls.map(([record]) => record.phase)).not.toContain("recovering")
    expect(stored()).toMatchObject({ phase: "waiting", waitReason: notReady.message })
    vi.mocked(steps.recoverRemaining).mockResolvedValue(undefined)
    await drive({ promptless: true })
    expect(stored().phase).toBe("recovering")
    expect(stored().waitReason).toBeUndefined()
  })

  it("sends a late batch again from an observe pass, and waits when the subsidy does not pay", async () => {
    const { drive, steps, observed, stored } = fixture()
    observed.metadataSettled = true
    observed.recurringSponsorship = true
    observed.sent = true
    const signal = new AbortController().signal
    steps.reconcileRemaining = vi.fn(async () => {
      throw new MigrationSubsidyNotReadyError(["subsidy balance is low"])
    })
    await drive({ start: true })
    await drive({ observeOnly: true, signal })
    expect(steps.reconcileRemaining).toHaveBeenCalledWith(
      "signed-plan",
      signal,
      expect.any(Function),
    )
    expect(stored()).toMatchObject({
      phase: "waiting",
      waitReason: "The fund that pays for moves is low. Try again later.",
    })
    vi.mocked(steps.reconcileRemaining).mockResolvedValue(undefined)
    await drive({ observeOnly: true, signal })
    expect(stored().phase).toBe("arriving")
  })

  it("sends each funds transaction through `exclusive`, from a recovery pass and an observe pass", async () => {
    const { drive, steps, observed } = fixture()
    observed.metadataSettled = true
    observed.recurringSponsorship = true
    const sends: (string | undefined)[] = []
    const send = async (gate?: <T>(step: (id?: string) => Promise<T>) => Promise<T>) => {
      await gate!(async (operationId) => void sends.push(operationId))
    }
    steps.recoverRemaining = vi.fn(async (_plan, _signal, gate) => send(gate))
    steps.reconcileRemaining = vi.fn(async (_plan, _signal, gate) => send(gate))
    let ids = 0
    const exclusive = vi.fn(<T>(step: (operationId?: string) => Promise<T>) => step(`op-${++ids}`))
    await drive({ start: true, exclusive })
    await drive({ observeOnly: true, exclusive })
    expect(steps.recoverRemaining).toHaveBeenCalledOnce()
    expect(steps.reconcileRemaining).toHaveBeenCalledOnce()
    expect(exclusive).toHaveBeenCalledTimes(2)
    expect(sends).toEqual(["op-1", "op-2"])
  })

  it("never starts a funds send that was cancelled while it waited its turn", async () => {
    const { drive, steps, observed } = fixture()
    observed.metadataSettled = true
    observed.recurringSponsorship = true
    const cancel = new AbortController()
    const sent = vi.fn()
    steps.reconcileRemaining = vi.fn(async (_plan, _signal, gate) => {
      await gate!(async () => sent())
    })
    await drive({ start: true })
    await drive({
      observeOnly: true,
      signal: cancel.signal,
      exclusive: (step) => {
        cancel.abort()
        return step()
      },
    })
    expect(sent).not.toHaveBeenCalled()
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

  it("waits on beforeApproval, after saving the count, while another approval is next", async () => {
    const { drive, steps, stored } = fixture()
    const seen: [number, number, unknown][] = []
    steps.prepare = vi.fn(async (_draft, _save, _signal, onApproval) => {
      await onApproval!(0, 2)
      await onApproval!(1, 2)
      await onApproval!(2, 2)
      return "signed-plan"
    })
    await drive({
      start: true,
      beforeApproval: async (approved, total) => {
        seen.push([approved, total, stored().approvals])
      },
    })
    expect(seen).toEqual([
      [0, 2, { approved: 0, total: 2 }],
      [1, 2, { approved: 1, total: 2 }],
    ])
  })

  it("asks for no approval once beforeApproval rejects", async () => {
    const { drive, steps } = fixture()
    const sign = vi.fn()
    steps.prepare = vi.fn(async (_draft, _save, _signal, onApproval) => {
      await onApproval!(0, 1)
      sign()
      return "signed-plan"
    })
    await drive({
      start: true,
      beforeApproval: () => Promise.reject(new Error("Cancelled")),
    }).catch(() => {})
    expect(sign).not.toHaveBeenCalled()
  })

  it("saves what a start was quoted, and keeps it through later passes", async () => {
    const { drive, stored } = fixture()
    const summary = { fees: "1500000000000000000", approvals: 4 }
    await drive({ start: true, summary })
    expect(stored().summary).toEqual(summary)
    await drive()
    await drive({ start: true })
    await drive({ observeOnly: true, summary: { fees: "1", approvals: 1 } })
    expect(stored().summary).toEqual(summary)
  })

  it("saves a new start's quote before its approve step, so a cancel there keeps it", async () => {
    const { drive, steps, observed, stored } = fixture()
    observed.metadataSettled = true
    observed.recurringSponsorship = true
    observed.complete = true
    await drive({ start: true, summary: { fees: "1", approvals: 3 } })
    expect(stored().phase).toBe("done")
    const cancel = new AbortController()
    steps.ready = vi.fn(async () => {
      cancel.abort()
      throw new Error("rpc down")
    })
    await drive({ start: true, signal: cancel.signal, summary: { fees: "2", approvals: 5 } })
    expect(stored().summary).toEqual({ fees: "2", approvals: 5 })
  })

  it("carries a published registration run to the end without the user, sending each step exclusively", async () => {
    const { drive, steps, observed, stored } = fixture()
    await drive({ start: true })
    vi.mocked(steps.prepare).mockClear()
    vi.mocked(steps.broadcast).mockClear()
    const exclusive = vi.fn(<T>(step: () => Promise<T>) => step())
    const follow = () => drive({ promptless: true, exclusive })
    observed.bootstrapStatus = "included"
    observed.bootstrapSpent = true
    await follow()
    expect(stored().phase).toBe("awaitingMessages")
    await follow() // A reload while the record update is on its way.
    expect(stored().phase).toBe("awaitingMessages")
    observed.metadataSettled = true
    observed.messagesReady = true
    await follow()
    await follow() // A reload after the subscription was submitted, before its receipt.
    expect(steps.subscribe).toHaveBeenCalledTimes(1)
    observed.subscriptionStatus = "included"
    observed.recurringSponsorship = true
    await follow()
    observed.complete = true
    await follow()
    expect(stored().phase).toBe("done")
    expect(steps.prepare).not.toHaveBeenCalled()
    expect(steps.ready).not.toHaveBeenCalled()
    expect(steps.broadcast).not.toHaveBeenCalled()
    // The subscription; a registration run's recovery sends nothing.
    expect(exclusive).toHaveBeenCalledTimes(1)
  })

  it("names each single-transaction step's operation to the step, and announces its saved hash", async () => {
    const { drive, steps, observed } = fixture()
    const saved = vi.fn()
    provingProgress.on("tx-hash-saved", saved)
    try {
      const exclusive = <T>(step: (operationId?: string) => Promise<T>) => step("op-step")
      await drive({ start: true, exclusive })
      expect(steps.broadcast).toHaveBeenCalledWith("signed-plan", expect.any(Function), "op-step")
      observed.bootstrapStatus = "included"
      observed.bootstrapSpent = true
      observed.metadataSettled = true
      observed.messagesReady = true
      await drive({ promptless: true, exclusive })
      expect(steps.subscribe).toHaveBeenCalledWith("signed-plan", expect.any(Function), "op-step")
      expect(saved.mock.calls.map(([ev]) => ev)).toEqual([
        expect.objectContaining({ operationId: "op-step", txHash: "bootstrap-hash" }),
        expect.objectContaining({ operationId: "op-step", txHash: "subscription-hash" }),
      ])
    } finally {
      provingProgress.off("tx-hash-saved", saved)
    }
  })

  it("waits for the record update without reserving the prover", async () => {
    const { drive, observed } = fixture()
    await drive({ start: true })
    observed.bootstrapStatus = "included"
    observed.bootstrapSpent = true
    const exclusive = vi.fn(<T>(step: (operationId?: string) => Promise<T>) => step())
    await drive({ promptless: true, exclusive })
    await drive({ promptless: true, exclusive })
    expect(exclusive).not.toHaveBeenCalled()
  })

  it("starts no step that was cancelled while it waited its turn", async () => {
    const { drive, steps, observed } = fixture()
    await drive({ start: true })
    observed.bootstrapStatus = "included"
    observed.bootstrapSpent = true
    observed.metadataSettled = true
    observed.messagesReady = true
    const cancel = new AbortController()
    await drive({
      promptless: true,
      signal: cancel.signal,
      exclusive: async (step) => {
        cancel.abort()
        return step()
      },
    })
    expect(steps.subscribe).not.toHaveBeenCalled()
  })

  describe("a promptless pass stops for the user", () => {
    it("with no plan to carry", async () => {
      const { drive, steps, stored } = fixture()
      await drive({ promptless: true })
      expect(stored().phase).toBe("needsApproval")
      expect(steps.prepare).not.toHaveBeenCalled()
    })

    it("rather than broadcast a bootstrap", async () => {
      const { drive, steps, stored } = fixture()
      steps.broadcast = vi.fn(async () => {
        throw new Error("node unavailable")
      })
      await drive({ start: true })
      await drive({ promptless: true })
      expect(stored().phase).toBe("needsApproval")
      expect(steps.broadcast).toHaveBeenCalledTimes(1)
    })

    it("rather than prepare a stale plan again", async () => {
      const { drive, steps, stored } = fixture()
      steps.broadcast = vi.fn(async () => {
        throw new StalePlanError("changed")
      })
      await drive({ start: true })
      await drive({ promptless: true })
      expect(stored()).toMatchObject({ phase: "needsApproval", plan: "signed-plan" })
      expect(steps.prepare).toHaveBeenCalledTimes(1)
    })

    it("rather than send a bootstrap the network dropped again", async () => {
      const { drive, steps, observed, stored } = fixture()
      await drive({ start: true })
      observed.bootstrapStatus = "dropped"
      await drive({ promptless: true })
      await drive({ promptless: true })
      expect(stored().phase).toBe("needsApproval")
      expect(steps.prepare).toHaveBeenCalledTimes(1)
      expect(steps.broadcast).toHaveBeenCalledTimes(1)
    })
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

  it("sends a dropped bootstrap again from the same plan", async () => {
    const { drive, observed, steps, stored } = fixture()
    await drive()
    observed.bootstrapStatus = "dropped"
    await drive()
    expect(steps.prepare).toHaveBeenCalledTimes(1)
    expect(steps.broadcast).toHaveBeenCalledTimes(2)
    expect(stored()).toMatchObject({ plan: "signed-plan", bootstrapTx: "bootstrap-hash" })
  })

  it("follows a dropped bootstrap that landed after all to its subscription", async () => {
    const { drive, observed, steps, stored } = fixture()
    await drive()
    observed.bootstrapStatus = "dropped"
    await drive()
    // The first bootstrap lands, so its resend is dropped.
    observed.bootstrapSpent = true
    await drive()
    expect(steps.broadcast).toHaveBeenCalledTimes(2)
    expect(stored()).toMatchObject({ phase: "broadcasting", plan: "signed-plan" })
    observed.metadataSettled = true
    observed.messagesReady = true
    await drive()
    expect(steps.subscribe).toHaveBeenCalledTimes(1)
    expect(steps.prepare).toHaveBeenCalledTimes(1)
  })

  it("prepares again once a dropped bootstrap's plan went stale", async () => {
    const { drive, observed, steps, stored } = fixture()
    await drive()
    observed.bootstrapStatus = "dropped"
    vi.mocked(steps.broadcast).mockRejectedValueOnce(new StalePlanError("changed"))
    await drive()
    expect(stored()).toMatchObject({ phase: "needsAttention", stale: true, plan: "signed-plan" })
    await drive()
    expect(stored().phase).toBe("needsApproval")
    vi.mocked(steps.prepare).mockResolvedValueOnce("replacement-plan")
    await drive({ start: true })
    expect(steps.prepare).toHaveBeenCalledTimes(2)
    expect(steps.broadcast).toHaveBeenCalledTimes(3)
    expect(vi.mocked(steps.broadcast).mock.calls[2][0]).toBe("replacement-plan")
    expect(stored()).toMatchObject({ plan: "replacement-plan", bootstrapTx: "bootstrap-hash" })
    expect(stored().stale).toBeUndefined()
  })

  it("keeps a stale plan's dropped bootstrap until a replacement is saved", async () => {
    const { drive, observed, steps, stored } = fixture()
    await drive()
    observed.bootstrapStatus = "dropped"
    vi.mocked(steps.broadcast).mockRejectedValueOnce(new StalePlanError("changed"))
    await drive()
    // The first bootstrap lands while the replacement is prepared, so its allowance refuses it.
    vi.mocked(steps.prepare).mockImplementationOnce(async () => {
      observed.bootstrapSpent = true
      observed.bootstrapStatus = "included"
      throw new Error("The registration-broadcast allowance is already spent")
    })
    await drive({ start: true })
    expect(stored()).toMatchObject({
      plan: "signed-plan",
      bootstrapTx: "bootstrap-hash",
      stale: true,
    })
    await drive({ start: true })
    expect(stored().phase).toBe("awaitingMessages")
    expect(steps.prepare).toHaveBeenCalledTimes(2)
    expect(steps.broadcast).toHaveBeenCalledTimes(2)
  })

  it("sends no transaction when the account binding changed", async () => {
    const { drive, steps, stored } = fixture()
    steps.binding = vi.fn(async () => "different-account")
    await drive()
    expect(stored().phase).toBe("needsAttention")
    expect(steps.prepare).not.toHaveBeenCalled()
    expect(steps.broadcast).not.toHaveBeenCalled()
  })

  it("keeps a registration run waiting until its record update reaches the destination", async () => {
    const { drive, observed, stored } = fixture()
    await drive()
    observed.bootstrapStatus = "included"
    observed.bootstrapSpent = true
    observed.complete = true // No source units left is insufficient evidence of completion.
    await drive()
    expect(stored().phase).toBe("awaitingMessages")
  })
})

it.each([
  ["needsApproval", new ApprovalNeededError()],
  ["needsAttention", Object.assign(new Error("closed"), { name: "NotAllowedError" })],
] as const)("a prepare-only retry clears a %s stop once ready", async (phase, error) => {
  const f = fixture()
  vi.mocked(f.steps.ready).mockRejectedValueOnce(error)
  await f.drive({ start: true, prepareOnly: true })
  await f.drive({ start: true, prepareOnly: true })
  expect(f.stored()).toMatchObject({ phase, plan: "signed-plan" })
  await f.drive({ start: true, prepareOnly: true })
  expect(f.stored()).toMatchObject({ phase: "broadcasting", plan: "signed-plan" })
  expect(f.stored().error).toBeUndefined()
})

it("persists all preparation before a queue authorizes any transaction", async () => {
  const f = fixture()
  await f.drive({ start: true, prepareOnly: true })
  expect(f.stored().plan).toBe("signed-plan")
  expect(f.steps.observe).not.toHaveBeenCalled()
  expect(f.steps.broadcast).not.toHaveBeenCalled()
  expect(f.steps.recoverRemaining).not.toHaveBeenCalled()
  await f.drive({ start: true })
  expect(f.steps.prepare).toHaveBeenCalledTimes(1)
  expect(f.steps.ready).toHaveBeenCalledWith("signed-plan", undefined, false, expect.any(Function))
  expect(f.steps.broadcast).toHaveBeenCalledTimes(1)
})
