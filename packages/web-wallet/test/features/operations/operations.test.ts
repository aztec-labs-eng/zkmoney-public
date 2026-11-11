/**
 * One path for every user transaction: an operation is tab-bound until its flow's record holds the
 * hash, and a reload or a takeover settles it either way. A record from before this tab became
 * active that never got a hash fails at once; one with a hash is left to the chain.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { testPage, testCore } from "../../support/page"
import { ProvingStage } from "@obsidion/core/types"
import {
  TxInFlightError,
  trackSubmission,
  userFlowActive,
  WalletError,
  type OperationRecord,
} from "@obsidion/front-core"
import { activeNamespace, closeSession, switchSession } from "../../../src/session/session"
import { pageSessionDeps } from "../../../src/app/sessionDeps"
import { testWalletDbs } from "../../support/fakeWalletDb"
import {
  currentOperation,
  runBackgroundOperation,
  runListedOperation,
  runOperation,
  tabLineOf,
  type OperationFlow,
  type OperationHandle,
  type RunOptions,
} from "../../../src/features/operations/operations"
import { recoverInterrupted } from "../../../src/features/operations/operationsTasks"
import { operationText } from "../../../src/features/operations/operationEntries"
import { sponsorshipErrorCopy } from "../../../src/features/allowance/sponsorshipError"
import { operationRecord, testOperations, testSession } from "../../support/operations"

const hash = `0x${"ab".repeat(32)}`
const flush = () => new Promise((r) => setTimeout(r, 0))
/** An ended operation's description: its summary, then the words for how it ended. */
const described = (summary: string, words: string) => [summary, words].join(". ")

beforeEach(() => {
  localStorage.clear()
  opened()
})

afterEach(() => {
  vi.restoreAllMocks()
  closeSession()
})

const opened = () => switchSession(activeNamespace(testCore().device), pageSessionDeps(testPage()))
const sweepStores = () => ({ withdrawals: opened().withdrawals, operations: testOperations() })

describe("runOperation", () => {
  it("returns the flow's result even when the settle write fails, and stays unsettled", async () => {
    const result = await runOperation(
      testSession(),
      { operationId: "op-full", flow: "send", summary: "$1 to @bob" },
      async () => {
        testWalletDbs().onApply = () => {
          throw new Error("QuotaExceededError")
        }
        return "done"
      },
    )
    expect(result).toBe("done")
    expect(operationRecord("op-full")?.state).toBe("local")
  })

  it("is local until it holds the hash, then settles with the flow", async () => {
    let seen: string | undefined
    await runOperation(
      testSession(),
      { operationId: "op-send", flow: "send", summary: "$25" },
      async (op) => {
        expect(operationRecord("op-send")?.state).toBe("local")
        await op.sent(hash)
        seen = operationRecord("op-send")?.state
        return hash
      },
      (h) => h,
    )
    expect(seen).toBe("sent")
    expect(operationRecord("op-send")).toMatchObject({ state: "settled", txHash: hash })
  })

  it("refuses the send when the operation did not save the hash", async () => {
    let node = false
    const refused = runOperation(
      testSession(),
      { operationId: "op-gone", flow: "send", summary: "$25" },
      async (op) => {
        await testOperations().remove("op-gone")
        await op.sent(hash)
        node = true
      },
    )
    await expect(refused).rejects.toMatchObject({ code: "invariant" })
    expect(node).toBe(false)
  })

  it("drops the record when nothing was sent", async () => {
    const cancel = new Error("Cancelled")
    const cancelled = runOperation(
      testSession(),
      { operationId: "op-c", flow: "send", summary: "$1" },
      async () => {
        throw cancel
      },
    )
    await expect(cancelled).rejects.toBe(cancel)
    expect(operationRecord("op-c")).toBeUndefined()
  })

  it("drops the record when the flow failed before proving began", async () => {
    const unregistered = new WalletError("contact.unregistered", "@bob", { data: { tag: "bob" } })
    const failed = runOperation(
      testSession(),
      { operationId: "op-r", flow: "send", summary: "$1" },
      async () => {
        throw unregistered
      },
    )
    await expect(failed).rejects.toBe(unregistered)
    expect(operationRecord("op-r")).toBeUndefined()
  })

  it.each([
    ["Assertion failed: Gas settings exceed whitelist max_fee", /network fees are too high/],
    ["Assertion failed: allowance exhausted", /no sponsored transactions left/],
  ])(
    "fails, not drops, a send whose screen handed off before proving began: %s",
    async (refusal, copy) => {
      const failed = runOperation(
        testSession(),
        { operationId: "op-h", flow: "send", summary: "$1" },
        async () => {
          await testOperations().apply("op-h", { type: "handedOff", at: Date.now() })
          throw new Error(refusal)
        },
      )
      await expect(failed).rejects.toThrow(refusal)
      const record = operationRecord("op-h")
      expect(record).toMatchObject({ state: "failed", error: refusal })
      const { description } = operationText(record!)
      expect(description).toBe(
        described("$1", sponsorshipErrorCopy(refusal, "contact:send")!.message),
      )
      expect(description).toMatch(copy)
    },
  )

  it("fails a local operation with the flow's error once proving began", async () => {
    const teeDown = new Error("TEE unavailable")
    const failed = runOperation(
      testSession(),
      { operationId: "op-f", flow: "send", summary: "$1" },
      async () => {
        await testSession().page.prover.turn(async ({ stage }) =>
          stage(ProvingStage.Simulating, "op-f"),
        )
        await flush()
        throw teeDown
      },
    )
    await expect(failed).rejects.toBe(teeDown)
    expect(operationRecord("op-f")).toMatchObject({
      state: "failed",
      error: teeDown.message,
      failure: { code: "unknown" },
    })
  })

  it("keeps the code a failure carries, its own or its cause's", async () => {
    const fail = (operationId: string, err: Error) =>
      expect(
        runOperation(testSession(), { operationId, flow: "send", summary: "$1" }, async () => {
          await testSession().page.prover.turn(async ({ stage }) =>
            stage(ProvingStage.Simulating, operationId),
          )
          await flush()
          throw err
        }),
      ).rejects.toBe(err)
    await fail("op-own", new WalletError("registration.ticketRefused"))
    await fail("op-cause", new Error("prepare", { cause: new WalletError("timeout") }))
    expect(operationRecord("op-own")?.failure?.code).toBe("registration.ticketRefused")
    expect(operationRecord("op-cause")?.failure?.code).toBe("timeout")
  })

  it("keeps a transfer that failed before its proof; only an automatic retry drops a retryable one", async () => {
    const claim = {
      networkId: "0xnet",
      token: {} as never,
      amountAtomic: "1",
      flavor: "direct",
      linkId: "L",
    } as const
    const send = { networkId: "0xnet", token: {} as never, amountAtomic: "1", to: "0xbob" }
    const fail = (
      operationId: string,
      transfer: Extract<Parameters<OperationHandle["transfer"]>[0], { kind: OperationFlow }>,
      err: Error,
      opts?: RunOptions,
    ) =>
      expect(
        runOperation(
          testSession(),
          { operationId, flow: transfer.kind, summary: "$1" },
          async (op) => {
            await op.transfer(transfer)
            throw err
          },
          undefined,
          opts,
        ),
      ).rejects.toBe(err)
    const auto = { dropRetryable: true }
    await fail("op-send", { kind: "send", payload: send }, new WalletError("timeout"))
    await fail("op-tap", { kind: "paylink-claim", payload: claim }, new WalletError("timeout"))
    const final = new WalletError("registration.ticketRefused")
    await fail("op-final", { kind: "paylink-claim", payload: claim }, final, auto)
    await fail(
      "op-retry",
      { kind: "paylink-claim", payload: claim },
      new WalletError("paylink.voucherUnread"),
      auto,
    )
    for (const id of ["op-send", "op-tap", "op-final"])
      expect(operationRecord(id)).toMatchObject({ state: "failed", readAt: expect.any(Number) })
    expect(operationRecord("op-retry")).toBeUndefined()
  })

  it("leaves a sent operation to the chain when the flow lost track of it", async () => {
    const store = testOperations()
    const lost = runOperation(
      testSession(),
      { operationId: "op-l", flow: "send", summary: "$1" },
      async () => {
        await store.apply("op-l", { type: "sent", txHash: hash })
        throw new TxInFlightError(hash, new Error("socket closed"))
      },
    )
    await expect(lost).rejects.toBeInstanceOf(TxInFlightError)
    expect(operationRecord("op-l")?.state).toBe("sent")
    expect(store.live.get().has("op-l")).toBe(false)
  })

  it("marks an in-flight operation sent from its error when nothing announced the hash", async () => {
    const store = testOperations()
    const lost = runOperation(
      testSession(),
      { operationId: "op-w", flow: "send", summary: "$1" },
      async () => {
        const submission = trackSubmission(testSession().page.prover.progress, "op-w")
        await testSession().page.prover.turn(async ({ stage }) =>
          stage(ProvingStage.Mining, "op-w", hash),
        )
        submission.stop()
        throw new TxInFlightError(hash, new Error("socket closed"))
      },
    )
    await expect(lost).rejects.toBeInstanceOf(TxInFlightError)
    expect(operationRecord("op-w")).toMatchObject({ state: "sent", txHash: hash })
    expect(store.live.get().has("op-w")).toBe(false)
  })

  it("leaves a burn that may still land to the chain with the hash it was sent under", async () => {
    const store = testOperations()
    await runOperation(
      testSession(),
      { operationId: "op-b", flow: "withdraw", summary: "$1" },
      async (op) => {
        op.leaveToChain(hash)
        return "pending-record"
      },
    )
    expect(operationRecord("op-b")).toMatchObject({ state: "sent", txHash: hash })
    expect(store.live.get().has("op-b")).toBe(false)
  })

  it("fails a sent operation with the flow's error when the chain turned it down", async () => {
    const turnedDown = new Error("The network dropped this payment")
    const dropped = runOperation(
      testSession(),
      { operationId: "op-d", flow: "send", summary: "$1" },
      async (op) => {
        await op.sent(hash)
        expect(operationRecord("op-d")?.state).toBe("sent")
        throw turnedDown
      },
    )
    await expect(dropped).rejects.toBe(turnedDown)
    expect(operationRecord("op-d")).toMatchObject({ state: "failed", error: turnedDown.message })
    expect(operationRecord("op-d")?.cause).toBeUndefined()
  })

  it("binds the tab to a live operation", async () => {
    const store = testOperations()
    await store.begin({
      operationId: "op-visitor",
      flow: "paylink-claim",
      summary: "$1",
    })
    try {
      expect(!!testOperations().tabBound.get()).toBe(true)
    } finally {
      await store.remove("op-visitor")
    }
    expect(!!testOperations().tabBound.get()).toBe(false)
  })

  it("holds the single-flight gate while it runs", async () => {
    let gated = false
    await runOperation(
      testSession(),
      { operationId: "op-g", flow: "send", summary: "$1" },
      async () => {
        gated = userFlowActive(testSession().page.prover.state.get())
      },
    )
    expect(gated).toBe(true)
    expect(userFlowActive(testSession().page.prover.state.get())).toBe(false)
  })
})

describe("currentOperation", () => {
  it("is the outermost live operation; every live local record still binds the tab", async () => {
    const store = testOperations()
    let release!: () => void
    const parentDone = runOperation(
      testSession(),
      { operationId: "parent", flow: "paylink-claim", summary: "$5 paylink" },
      () =>
        runOperation(
          testSession(),
          { operationId: "child", flow: "deposit", summary: "Deposit address", parent: "parent" },
          () => new Promise<void>((resolve) => (release = resolve)),
        ),
    )
    await flush()
    await flush()
    const records = store.view.get().records
    expect(records.find((r) => r.operationId === "child")?.parent).toBe("parent")
    const current = () => currentOperation(store.running.get(), store.live.get())
    expect(current()?.operationId).toBe("parent")
    // The child alone binds the tab once its parent stopped running.
    store.release("parent")
    expect(current()?.operationId).toBe("child")
    expect(store.tabBound.get()).toBeDefined()
    release()
    await parentDone
    expect(current()).toBeUndefined()
  })
})

describe("a background operation", () => {
  it("is listed in no notification, names no busy label, and leaving does not lose it", async () => {
    const store = testOperations()
    await store.begin({
      operationId: "op-bg",
      flow: "deposit",
      summary: "Deposit address",
      resumable: true,
      background: true,
    })
    try {
      expect(store.live.get().has("op-bg")).toBe(true)
      expect(!!testOperations().tabBound.get()).toBe(false)
      expect(currentOperation(store.view.get().records, store.live.get())).toBeUndefined()
      expect(store.running.get().map((r) => r.operationId)).not.toContain("op-bg")
    } finally {
      await store.remove("op-bg")
    }
  })
})

describe("runBackgroundOperation", () => {
  const step = { operationId: "op-step", flow: "migration" as const, summary: "Upgrade" }

  it("runs a background record outside the user's gate, and a user flow raised meanwhile waits it out", async () => {
    let release!: () => void
    const running = runBackgroundOperation(
      testSession(),
      step,
      () => new Promise<void>((r) => (release = r)),
    )
    await flush()
    expect(operationRecord("op-step")).toMatchObject({ state: "local", background: true })
    expect(userFlowActive(testSession().page.prover.state.get())).toBe(false)
    expect(!!testOperations().tabBound.get()).toBe(false)
    let sent = false
    const user = runOperation(
      testSession(),
      { operationId: "op-user", flow: "send", summary: "$1" },
      async () => {
        sent = true
      },
    )
    await flush()
    expect(sent).toBe(false)
    release()
    await Promise.all([running, user])
    expect(sent).toBe(true)
    expect(operationRecord("op-step")?.state).toBe("settled")
  })

  it("drops a step that failed before proving, and fails one a reload cut off while proving", async () => {
    const store = testOperations()
    const relayerDown = new Error("relayer unavailable")
    await expect(
      runBackgroundOperation(testSession(), step, async () => {
        throw relayerDown
      }),
    ).rejects.toBe(relayerDown)
    expect(operationRecord("op-step")).toBeUndefined()
    await store.begin({ ...step, background: true }, 9_000)
    await store.apply("op-step", { type: "proving", at: Date.now() })
    store.release("op-step")
    await recoverInterrupted(sweepStores(), 10_000, 20_000)
    expect(operationRecord("op-step")).toMatchObject({ state: "failed", cause: "interrupted" })
  })
})

describe("runListedOperation", () => {
  it("lists the operation and keeps the tab, but raises no user flow, so a background step inside runs", async () => {
    const steps: boolean[] = []
    await runListedOperation(
      testSession(),
      { operationId: "op-listed", flow: "migration", summary: "Upgrade" },
      async () => {
        expect(userFlowActive(testSession().page.prover.state.get())).toBe(false)
        expect(operationRecord("op-listed")).toMatchObject({ state: "local" })
        expect(operationRecord("op-listed")?.background).toBeFalsy()
        expect(!!testOperations().tabBound.get()).toBe(true)
        await runBackgroundOperation(
          testSession(),
          { operationId: "op-step", flow: "migration", summary: "Upgrade" },
          async () => void steps.push(userFlowActive(testSession().page.prover.state.get())),
        )
      },
    )
    expect(steps).toEqual([false])
    expect(operationRecord("op-listed")?.state).toBe("settled")
  })

  it("removes the record of a flow that stopped before anything was proven", async () => {
    await expect(
      runListedOperation(
        testSession(),
        { operationId: "op-stop", flow: "migration", summary: "Upgrade" },
        () => Promise.reject(new Error("stopped")),
      ),
    ).rejects.toThrow("stopped")
    expect(operationRecord("op-stop")).toBeUndefined()
  })
})

describe("recoverInterrupted", () => {
  const activeSince = 10_000
  const now = 20_000

  it("fails a withdrawal a reload cut off before submit, and keeps one that was sent", async () => {
    const withdrawals = opened().withdrawals
    const seed = (localId: string, l2TxHash?: string) =>
      withdrawals.create({
        localId,
        networkId: "0xnet",
        recipient: `0x${"22".repeat(20)}`,
        recipientProvenance: "saved-recipient",
        amount: "12.1",
        tokenSymbol: "DAI",
        phase: "submitting",
        startTime: activeSince - 5_000,
        ...(l2TxHash ? { l2TxHash } : {}),
      } as Parameters<typeof withdrawals.create>[0])
    await seed("cut-off")
    await seed("sent", hash)
    await recoverInterrupted(sweepStores(), activeSince, now)
    expect((await withdrawals.get("cut-off"))?.phase).toBe("failed")
    expect((await withdrawals.get("sent"))?.phase).toBe("submitting")
  })

  it("fails every operation from before this tab became active, never this tab's", async () => {
    const ops = testOperations()
    await ops.begin({ operationId: "old", flow: "send", summary: "$1" }, activeSince - 1)
    await ops.apply("old", { type: "proving", at: Date.now() })
    ops.release("old")
    await ops.begin(
      { operationId: "other-scope", flow: "paylink-claim", summary: "$1" },
      activeSince - 1,
    )
    await ops.apply("other-scope", { type: "proving", at: Date.now() })
    ops.release("other-scope")
    await ops.begin({ operationId: "never-proved", flow: "send", summary: "$1" }, activeSince - 1)
    ops.release("never-proved")
    await ops.begin({ operationId: "new", flow: "send", summary: "$1" }, activeSince + 1)
    await recoverInterrupted(sweepStores(), activeSince, now)
    expect(operationRecord("old")).toMatchObject({ state: "failed", cause: "interrupted" })
    expect(operationRecord("other-scope")).toMatchObject({ state: "failed", cause: "interrupted" })
    expect(operationRecord("never-proved")).toBeUndefined()
    expect(operationRecord("new")?.state).toBe("local")
  })
})

describe("tabLineOf", () => {
  const record = (state: string) => ({ operationId: "t", flow: "send", state } as OperationRecord)

  it("keeps the tab while this page proves the operation, and frees it once sent", () => {
    expect(tabLineOf(record("local"), true)).toBe("keep")
    expect(tabLineOf(record("sent"), true)).toBe("safe")
    expect(tabLineOf(record("sent"), false)).toBe("safe")
  })

  it("says nothing for a record no flow in this page runs, one that ended, or none", () => {
    expect(tabLineOf(record("local"), false)).toBeUndefined()
    expect(tabLineOf(record("settled"), true)).toBeUndefined()
    expect(tabLineOf(null, true)).toBeUndefined()
  })
})
