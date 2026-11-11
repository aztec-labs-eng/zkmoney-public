import { describe, expect, it } from "vitest"
import { TxExecutionResult, TxStatus } from "@aztec-labs/stdlib/tx"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import { createOperations } from "../../src/engine/operations"
import { OPERATIONS_STORAGE_KEY } from "../../src/storageMigrations/operations"
import { loadRecords } from "../../src/engine/persistentStore"
import {
  operationTransition,
  type OperationEvent,
  type OperationRecord,
} from "../../src/engine/operationTransition"

const hash = `0x${"11".repeat(32)}`
const DAY = 24 * 60 * 60 * 1000

function open(entries = new Map<string, string>(), scope: string | null = "acct") {
  const backend = memoryBackend(entries)
  const page = openDatabase(backend)
  const operations = createOperations({
    db: page.scoped(`ns.${scope}.`),
    legacy: { db: page, scope },
    now: () => Date.now(),
  })
  return { backend, entries, operations }
}

const record = (patch: Partial<OperationRecord> = {}): OperationRecord => ({
  operationId: "op",
  flow: "send",
  summary: "$25 to @alice",
  state: "local",
  startedAt: 1_000,
  ...patch,
})

describe("operationTransition", () => {
  const local = record()
  const sent = record({ state: "sent", txHash: hash })
  const settled = record({ state: "settled", txHash: hash, endedAt: 5 })
  const resumable = record({ state: "sent", resumable: true, txHash: hash, provingStartedAt: 2 })
  const cases: [string, OperationRecord, OperationEvent, Partial<OperationRecord> | undefined][] = [
    [
      "proving stamps a local record once",
      local,
      { type: "proving", at: 2 },
      { provingStartedAt: 2 },
    ],
    [
      "proving leaves an earlier stamp",
      record({ provingStartedAt: 1 }),
      { type: "proving", at: 2 },
      undefined,
    ],
    ["proving leaves a sent record", sent, { type: "proving", at: 2 }, undefined],
    ["a hand-off stamps a local record", local, { type: "handedOff", at: 3 }, { handedOffAt: 3 }],
    ["a hand-off leaves a sent record", sent, { type: "handedOff", at: 3 }, undefined],
    [
      "sent takes a local record's hash",
      local,
      { type: "sent", txHash: hash },
      { state: "sent", txHash: hash },
    ],
    ["sent leaves a settled record", settled, { type: "sent", txHash: "0x2" }, undefined],
    [
      "settled keeps the sent hash",
      sent,
      { type: "settled", at: 5 },
      { state: "settled", txHash: hash, endedAt: 5 },
    ],
    ["settled leaves an ended record", settled, { type: "settled", at: 9 }, undefined],
    [
      "failed carries why",
      sent,
      { type: "failed", at: 6, cause: "dropped" },
      { state: "failed", cause: "dropped", endedAt: 6 },
    ],
    [
      "failed keeps the flow's code",
      local,
      { type: "failed", at: 6, error: "x", failure: { code: "timeout" } },
      { state: "failed", error: "x", failure: { code: "timeout" }, endedAt: 6 },
    ],
    ["failed leaves an ended record", settled, { type: "failed", at: 9, error: "x" }, undefined],
    [
      "resumed runs a resumable record afresh",
      resumable,
      { type: "resumed" },
      { state: "local", txHash: undefined, provingStartedAt: undefined },
    ],
    ["resumed leaves one not resumable", sent, { type: "resumed" }, undefined],
    ["resumed leaves an ended one", { ...resumable, endedAt: 5 }, { type: "resumed" }, undefined],
    ["described renames", local, { type: "described", summary: "$30" }, { summary: "$30" }],
    [
      "described leaves the same name",
      local,
      { type: "described", summary: local.summary },
      undefined,
    ],
    ["read stamps an ending once", settled, { type: "read", at: 7 }, { readAt: 7 }],
    ["read leaves a running record", sent, { type: "read", at: 7 }, undefined],
    [
      "dismissed reads and clears an ending",
      settled,
      { type: "dismissed", at: 8 },
      { readAt: 8, dismissedAt: 8 },
    ],
    ["dismissed leaves a running record", local, { type: "dismissed", at: 8 }, undefined],
  ]
  it.each(cases)("%s", (_name, before, event, after) => {
    const next = operationTransition(before, event)
    if (after === undefined) expect(next).toBeUndefined()
    else expect(next).toEqual(JSON.parse(JSON.stringify({ ...before, ...after })))
  })
})

describe("the operations store", () => {
  it("owns an operation only once its record is written", async () => {
    const { backend, operations } = open()
    await operations.ready
    backend.failing.commits = true
    await expect(operations.begin(record())).rejects.toThrow()
    expect(operations.live.get().has("op")).toBe(false)
    expect(operations.view.get().records).toEqual([])
    backend.failing.commits = false
    await operations.begin(record())
    expect(operations.live.get().has("op")).toBe(true)
  })

  it("binds the tab to an operation begun before the view's first load", async () => {
    const backend = memoryBackend()
    let loaded!: () => void
    const held = new Promise<void>((resolve) => (loaded = resolve))
    // The view's load of the records stalls until the test lets it through.
    const range: typeof backend.range = async (prefix, opts) => {
      if (prefix.endsWith("acct/operations/")) await held
      return backend.range(prefix, opts)
    }
    const operations = createOperations({
      db: openDatabase({ ...backend, range }).scoped("ns."),
      now: () => Date.now(),
    })
    const begun = operations.begin(record())
    await new Promise((r) => setTimeout(r, 0))
    loaded()
    await begun
    expect(operations.tabBound.get()?.operationId).toBe("op")
  })

  it("starts nothing when its view cannot load", async () => {
    const { backend, operations } = open()
    backend.failing.reads = true
    await expect(operations.begin(record())).rejects.toThrow()
    expect([...backend.entries.keys()].some((k) => k.includes("acct/operations/"))).toBe(false)
    expect(operations.live.get().has("op")).toBe(false)
  })

  const held: [
    string,
    (ops: ReturnType<typeof open>["operations"]) => Promise<unknown>,
    string?,
  ][] = [
    ["nothing", async () => {}],
    ["a live local record", (ops) => ops.begin(record()), "operation.running"],
    ["a local record no flow runs", (ops) => ops.begin(record()).then(() => ops.release("op"))],
    ["a begin still writing", (ops) => void ops.begin(record()), "operation.running"],
    [
      "a sent record its flow left",
      async (ops) => {
        await ops.begin(record())
        await ops.apply("op", { type: "sent", txHash: hash })
        ops.release("op")
      },
      "operation.sent",
    ],
    [
      "a settled record",
      (ops) => ops.begin(record()).then(() => ops.apply("op", { type: "settled", at: 2 })),
      "operation.sent",
    ],
    [
      "a failed record",
      (ops) => ops.begin(record()).then(() => ops.apply("op", { type: "failed", at: 2 })),
    ],
  ]
  it.each(held)("begins an id over %s, or refuses it", async (_, hold, refusal) => {
    const { operations } = open()
    await operations.ready
    await hold(operations)
    const begun = operations.begin(record({ summary: "again" }), 9)
    if (refusal) {
      await expect(begun).rejects.toMatchObject({ code: refusal })
    } else {
      await begun
      expect(operations.view.get().records).toEqual([record({ summary: "again", startedAt: 9 })])
      expect(operations.live.get().has("op")).toBe(true)
    }
  })

  it("reads a hash the flow saved before it reads the record", async () => {
    const { operations } = open()
    await operations.begin(record())
    void operations.apply("op", { type: "sent", txHash: hash })
    expect(await operations.get("op")).toMatchObject({ state: "sent", txHash: hash })
  })

  it("lists listed records newest first, and binds the tab to a live local one", async () => {
    const { operations } = open()
    await operations.begin(record({ operationId: "a", startedAt: 1 }), 1)
    await operations.begin(record({ operationId: "b" }), 2)
    await operations.begin(record({ operationId: "bg", background: true }), 3)
    expect(operations.running.get().map((r) => r.operationId)).toEqual(["b", "a"])
    expect(operations.tabBound.get()?.operationId).toBe("a")
    await operations.apply("a", { type: "settled", at: 4 })
    expect(operations.live.get().has("a")).toBe(false)
    expect(operations.ended.get().map((r) => r.operationId)).toEqual(["a"])
    expect(operations.tabBound.get()?.operationId).toBe("b")
    operations.release("b")
    expect(operations.tabBound.get()).toBeUndefined()
  })

  it("runs a resumable record again as this page's", async () => {
    const { operations } = open()
    await operations.begin(record({ resumable: true }))
    operations.release("op")
    await operations.resume("op")
    expect(operations.live.get().has("op")).toBe(true)
  })

  it("sweeps what an earlier tab left before submit, and ended records past retention", async () => {
    const { operations } = open()
    await operations.begin(record({ operationId: "unproved" }), 1_000)
    await operations.begin(record({ operationId: "proving" }), 1_000)
    await operations.apply("proving", { type: "proving", at: 1_100 })
    await operations.begin(record({ operationId: "handed" }), 1_000)
    await operations.apply("handed", { type: "handedOff", at: 1_100 })
    await operations.begin(record({ operationId: "resumable", resumable: true }), 1_000)
    await operations.begin(record({ operationId: "mine" }), 2_001)
    await operations.begin(record({ operationId: "old" }), 1_000)
    await operations.apply("old", { type: "settled", at: 1_500 })
    await operations.sweep(2_000, 1_500 + 31 * DAY)
    const states = Object.fromEntries(
      operations.view.get().records.map((r) => [r.operationId, [r.state, r.cause]]),
    )
    expect(states).toEqual({
      proving: ["failed", "interrupted"],
      handed: ["failed", "interrupted"],
      resumable: ["local", undefined],
      mine: ["local", undefined],
    })
  })

  it("changes nothing when the sweep's write fails", async () => {
    const { backend, operations } = open()
    await operations.begin(record({ operationId: "unproved" }), 1_000)
    backend.failing.commits = true
    await expect(operations.sweep(2_000, 3_000)).rejects.toThrow()
    expect(operations.view.get().records).toHaveLength(1)
  })

  it("settles unowned sent records from their receipts and leaves the rest", async () => {
    const { operations } = open()
    const ids = ["included", "dropped", "pending", "unreachable", "owned"]
    const hashOf = (i: number) => `0x${String(i + 1).padStart(64, "0")}`
    for (const [i, operationId] of ids.entries()) {
      await operations.begin(record({ operationId }), 1_000)
      await operations.apply(operationId, { type: "sent", txHash: hashOf(i) })
      if (operationId !== "owned") operations.release(operationId)
    }
    const node = {
      getTxReceipt: async (txHash: { toString(): string }) => {
        const id = ids[ids.findIndex((_, i) => hashOf(i) === txHash.toString())]
        if (id === "unreachable") throw new Error("offline")
        if (id === "dropped") return { status: TxStatus.DROPPED } as never
        if (id === "included")
          return {
            status: TxStatus.CHECKPOINTED,
            executionResult: TxExecutionResult.SUCCESS,
            blockNumber: 7,
          } as never
        return { status: TxStatus.PENDING } as never
      },
    }
    await operations.resolveSent(node, 9_000)
    const states = Object.fromEntries(
      operations.view.get().records.map((r) => [r.operationId, r.state]),
    )
    expect(states).toEqual({
      included: "settled",
      dropped: "failed",
      pending: "sent",
      unreachable: "sent",
      owned: "sent",
    })
  })

  it("clears every ending and leaves running operations", async () => {
    const { operations } = open()
    await operations.begin(record({ operationId: "done" }))
    await operations.apply("done", { type: "settled", at: 2 })
    await operations.begin(record({ operationId: "running" }))
    await operations.dismissEnded(5)
    const cleared = operations.view.get().records.map((r) => [r.operationId, r.dismissedAt])
    expect(Object.fromEntries(cleared)).toEqual({ done: 5, running: undefined })
  })
})

describe("the move out of the page-wide blob", () => {
  const blob = JSON.stringify({
    mine: { ...record({ operationId: "mine", state: "sent", txHash: hash }), scope: "acct" },
    theirs: { ...record({ operationId: "theirs" }), scope: "other" },
    visitor: { ...record({ operationId: "visitor" }), scope: null },
  })

  it("carries this namespace's records without their scope, and leaves the blob", async () => {
    const { entries, operations } = open(new Map([[OPERATIONS_STORAGE_KEY, blob]]))
    expect(await loadRecords(operations.view)).toEqual([
      record({ operationId: "mine", state: "sent", txHash: hash }),
    ])
    expect(entries.get(OPERATIONS_STORAGE_KEY)).toBe(blob)
  })

  it("carries a visitor's records into the anonymous namespace", async () => {
    const { operations } = open(new Map([[OPERATIONS_STORAGE_KEY, blob]]), null)
    expect((await loadRecords(operations.view)).map((r) => r.operationId)).toEqual(["visitor"])
  })

  it.each([
    ["a blob that does not parse", "{"],
    ["a blob that is not a record map", "[]"],
    ["a record that is not one", JSON.stringify({ x: { operationId: "x", scope: "other" } })],
    ["a record of another type of scope", JSON.stringify({ x: { ...record(), scope: 42 } })],
    ["a field of the wrong type", JSON.stringify({ x: { ...record(), resumable: "false" } })],
  ])("fails the open and keeps the bytes for %s", async (_, raw) => {
    const { entries, operations } = open(new Map([[OPERATIONS_STORAGE_KEY, raw]]))
    await expect(operations.ready).rejects.toThrow()
    expect(operations.view.get().failed).toBe(true)
    expect([...entries]).toEqual([[OPERATIONS_STORAGE_KEY, raw]])
  })

  it("runs once: a record it carried and then dropped stays dropped", async () => {
    const entries = new Map([[OPERATIONS_STORAGE_KEY, blob]])
    const first = open(entries).operations
    await first.ready
    await first.remove("mine")
    const second = open(entries).operations
    expect(await loadRecords(second.view)).toEqual([])
  })
})
