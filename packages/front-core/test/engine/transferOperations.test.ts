/**
 * An own transfer is its operation: the transition's transfer events, what the store keeps and
 * carries, the rows the feed derives, and how the scan and the reorg monitor treat its hash.
 */
import { describe, expect, it } from "vitest"
import { TxExecutionResult, TxStatus } from "@aztec-labs/stdlib/tx"
import { PaylinkActionEnum } from "@obsidion/core/constants"
import { ReorgMonitor } from "../../src/core/services/coordination/ReorgMonitor"
import { TransferEventScanner } from "../../src/core/services/transactions/TransferEventScanner"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import {
  createOperations,
  operationRows,
  operationIndex,
  withOperation,
  type Operations,
} from "../../src/engine/operations"
import { OPERATIONS_STORAGE_KEY } from "../../src/storageMigrations/operations"
import {
  operationTransition,
  type OperationEvent,
  type OperationRecord,
  type PayoutPayload,
  type SendPayload,
} from "../../src/engine/operationTransition"
import { encodeRecord, loadRecords } from "../../src/engine/persistentStore"
import { memoryStore } from "../../src/engine/store"
import { createTransfers } from "../../src/engine/transfers"
import { TRANSACTIONS_STORAGE_KEY } from "../../src/core/storages/constants"
import { seededActivity } from "../utils/transferFixture"

const HASH = `0x${"11".repeat(32)}`
const DAY = 24 * 60 * 60 * 1000
const token = { address: "0xt", name: "DAI", symbol: "DAI", decimals: 6, logo: "", price: 1 }
const send: SendPayload = {
  networkId: "net",
  token: { ...token, amount: 2 },
  amountAtomic: "2000000",
  to: "0xbob",
  toTag: "bob",
}
const claim: PayoutPayload = {
  networkId: "net",
  token: { ...token, amount: 5 },
  amountAtomic: "5000000",
  flavor: "direct",
  linkId: "link-1",
}

const op = (patch: Partial<OperationRecord> = {}): OperationRecord =>
  ({
    operationId: "op",
    flow: "send",
    summary: "",
    state: "local",
    startedAt: 1_000,
    ...patch,
  } as OperationRecord)

const sendOp = (patch: Partial<OperationRecord> = {}) =>
  op({ kind: "send", payload: send, ...patch } as Partial<OperationRecord>)

describe("operationTransition: a transfer's events", () => {
  const settled = sendOp({ state: "settled", txHash: HASH, endedAt: 5, readAt: 6, dismissedAt: 6 })
  const cases: [string, OperationRecord, OperationEvent, Partial<OperationRecord> | undefined][] = [
    [
      "transfer sets what a local record's row shows",
      op(),
      { type: "transfer", transfer: { kind: "send", payload: send } },
      { kind: "send", payload: send } as Partial<OperationRecord>,
    ],
    [
      "transfer leaves a sent record",
      op({ state: "sent", txHash: HASH }),
      { type: "transfer", transfer: { kind: "send", payload: send } },
      undefined,
    ],
    [
      "demoted reopens a settled record, to be reported afresh",
      settled,
      { type: "demoted" },
      { state: "sent", endedAt: undefined, readAt: undefined, dismissedAt: undefined },
    ],
    [
      "demoted reopens a dropped record",
      sendOp({ state: "failed", txHash: HASH, cause: "dropped", endedAt: 5 }),
      { type: "demoted" },
      { state: "sent", cause: undefined, endedAt: undefined },
    ],
    [
      "demoted leaves a running record",
      sendOp({ state: "sent", txHash: HASH }),
      { type: "demoted" },
      undefined,
    ],
    [
      "demoted leaves a final record",
      { ...settled, finalized: true },
      { type: "demoted" },
      undefined,
    ],
    [
      "demoted leaves a failure with no hash",
      sendOp({ state: "failed", endedAt: 5 }),
      { type: "demoted" },
      undefined,
    ],
    ["finalized marks a settled record", settled, { type: "finalized" }, { finalized: true }],
    [
      "finalized leaves a running record",
      sendOp({ state: "sent" }),
      { type: "finalized" },
      undefined,
    ],
    [
      "noted fills a missing memo",
      op({ kind: "paylink-claim", payload: claim } as Partial<OperationRecord>),
      { type: "noted", memo: "lunch" },
      { payload: { ...claim, memo: "lunch" } } as Partial<OperationRecord>,
    ],
    [
      "noted keeps a memo",
      sendOp({ payload: { ...send, memo: "rent" } } as Partial<OperationRecord>),
      { type: "noted", memo: "lunch" },
      undefined,
    ],
    ["noted leaves a record with no transfer", op(), { type: "noted", memo: "lunch" }, undefined],
    [
      "a quiet failure is read and cleared",
      sendOp(),
      { type: "failed", at: 7, quiet: true },
      { state: "failed", endedAt: 7, readAt: 7, dismissedAt: 7 },
    ],
  ]
  it.each(cases)("%s", (_name, before, event, after) => {
    const next = operationTransition(before, event)
    if (after === undefined) expect(next).toBeUndefined()
    else expect(next).toEqual(JSON.parse(JSON.stringify({ ...before, ...after })))
  })
})

function open(entries = new Map<string, string>()) {
  const backend = memoryBackend(entries)
  const page = openDatabase(backend)
  const db = page.scoped("ns.")
  return {
    db,
    operations: createOperations({
      db,
      legacy: { db: page, scope: "acct" },
      now: () => Date.now(),
    }),
  }
}

describe("the operations store: transfers", () => {
  it("keeps a transfer's record past retention, and fails a never-proved one quietly", async () => {
    const { operations } = open()
    await operations.begin(sendOp({ operationId: "old" }), 1)
    await operations.apply("old", { type: "settled", at: 2 })
    await operations.begin(sendOp({ operationId: "lost" }), 3)
    await operations.begin(op({ operationId: "plain" }), 3)
    await operations.sweep(10, 40 * DAY)
    const records = await loadRecords(operations.view)
    expect(records.map((r) => [r.operationId, r.state, r.dismissedAt]).sort()).toEqual([
      ["lost", "failed", 40 * DAY],
      ["old", "settled", undefined],
    ])
  })

  it("carries a local record sent through its activity row's hash, or its burn's", async () => {
    const blob = {
      a: { ...op({ operationId: "a" }), scope: "acct" },
      b: { ...op({ operationId: "b" }), scope: "acct" },
      c: { ...op({ operationId: "c" }), scope: "acct" },
    }
    const entries = new Map([
      [OPERATIONS_STORAGE_KEY, JSON.stringify(blob)],
      ["ns.acct/transfers/a", encodeRecord({ id: "a", txHash: HASH })],
      ["ns.acct/withdrawals/w", encodeRecord({ localId: "w", operationId: "b", l2TxHash: "0xb" })],
    ])
    const { operations } = open(entries)
    const states = (await loadRecords(operations.view)).map((r) => [r.state, r.txHash])
    expect(states).toEqual([
      ["sent", HASH],
      ["sent", "0xb"],
      ["local", undefined],
    ])
  })

  it("carries the hash of a version 1 store's local record from its row or its burn", async () => {
    const entries = new Map([
      ["ns.acct/meta/operations", "1"],
      ["ns.acct/operations/a", encodeRecord(op({ operationId: "a" }))],
      ["ns.acct/operations/b", encodeRecord(op({ operationId: "b" }))],
      ["ns.acct/operations/c", encodeRecord(op({ operationId: "c" }))],
      ["ns.acct/transfers/a", encodeRecord({ id: "a", txHash: HASH })],
      ["ns.acct/withdrawals/w", encodeRecord({ localId: "w", operationId: "b", l2TxHash: "0xb" })],
    ])
    const { operations } = open(entries)
    const states = (await loadRecords(operations.view)).map((r) => [r.state, r.txHash])
    expect(states).toEqual([
      ["sent", HASH],
      ["sent", "0xb"],
      ["local", undefined],
    ])
  })

  it("carries a hash from a row activity's first open imports, once that open lands", async () => {
    const blob = { a: { ...op({ operationId: "a" }), scope: "acct" } }
    const row = {
      action: "send",
      token,
      timestamp: 1,
      status: "pending",
      txHash: HASH,
      operationId: "a",
    }
    const entries = new Map([
      [OPERATIONS_STORAGE_KEY, JSON.stringify(blob)],
      [`ns.${TRANSACTIONS_STORAGE_KEY}`, JSON.stringify([row])],
    ])
    const page = openDatabase(memoryBackend(entries))
    const db = page.scoped("ns.")
    let opened!: () => void
    const ready = new Promise<void>((resolve) => (opened = resolve))
    const operations = createOperations({
      db,
      legacy: { db: page, scope: "acct" },
      transfers: { ready },
      now: () => Date.now(),
    })
    const transfers = createTransfers({ db, now: () => Date.now() })
    await transfers.ready
    opened()
    expect(await operations.get("a")).toMatchObject({ state: "sent", txHash: HASH })
  })

  it("derives each transfer's row, and joins a link to its local refund", () => {
    const records = [
      sendOp({ operationId: "s", state: "sent", txHash: "0xAB" }),
      op({
        operationId: "c",
        kind: "paylink-claim",
        payload: claim,
        state: "failed",
        cause: "interrupted",
      } as Partial<OperationRecord>),
      op({ operationId: "r", kind: "paylink-refund", payload: claim } as Partial<OperationRecord>),
      op({ operationId: "plain", state: "settled" }),
    ]
    const rows = operationRows({ records, loaded: true, failed: false }).records
    expect(rows.map((r) => [r.id, r.action, r.status])).toEqual([
      ["0xab", "send", "pending"],
      ["c", PaylinkActionEnum.CLAIM, "failed"],
      ["r", PaylinkActionEnum.CLAIM_BACK, "pending"],
    ])
    expect(rows[1].failure).toEqual({ code: "tx.interrupted" })
    expect(rows[0]).toMatchObject({ to: "0xbob", toTag: "bob", amountAtomic: 2_000_000n })
    const index = operationIndex(records)
    expect(withOperation({ id: "link-1" }, index).refunding?.operationId).toBe("r")
    expect(withOperation({ id: "link-2" }, index).refunding).toBeUndefined()
  })
})

describe("the transfer scan: a hash an operation holds", () => {
  const event = { txHash: HASH, from: "0xme", to: "0xbob", amount: "2000000", blockNumber: 10 }
  async function scan(memo?: string, view?: Operations["view"]) {
    const transfers = seededActivity([])
    const operations = createOperations({ db: transfers.db, now: () => Date.now() })
    await operations.begin(
      op({ operationId: "c", kind: "paylink-claim", payload: claim } as Partial<OperationRecord>),
    )
    await operations.apply("c", { type: "sent", txHash: HASH })
    const scanner = new TransferEventScanner({
      source: {
        headBlock: async () => 20,
        listIncoming: async () => [{ ...event, memo }],
        blockTimestampMs: async () => 5_000,
      },
      db: transfers.db,
      transactionStore: transfers,
      operations: view ? { view, apply: operations.apply } : operations,
      tags: { resolveL2: async () => null },
      contacts: { findByL2Address: async () => null, registerL2: async () => {} },
      token,
    })
    const complete = await scanner.pass(
      { accountAddress: "0xme", accountTag: "me", networkId: "net" },
      { full: true },
    )
    return { complete, rows: await transfers.all(), claim: await operations.get("c") }
  }

  it("files no row, settles the operation and fills its memo", async () => {
    const { complete, rows, claim } = await scan("lunch")
    expect(complete).toBe(true)
    expect(rows).toEqual([])
    expect(claim).toMatchObject({ state: "settled", payload: { memo: "lunch" } })
  })

  it("holds the chunk while the operations have not loaded", async () => {
    const view = memoryStore({ records: [] as OperationRecord[], loaded: false, failed: false })
    const { complete, rows, claim } = await scan(undefined, view.readonly)
    expect(complete).toBe(false)
    expect(rows).toEqual([])
    expect(claim?.state).toBe("sent")
  })
})

describe("the reorg monitor: operations", () => {
  const receipts = (
    by: Record<string, { status: TxStatus; executionResult?: TxExecutionResult }>,
  ) => ({
    getTxReceipt: async (txHash: string) => by[txHash] ?? { status: TxStatus.DROPPED },
  })

  it("reopens a settled one the chain dropped and a failed one it includes, and marks a final one", async () => {
    const { operations } = open()
    const now = Date.now()
    const settle = async (operationId: string, txHash: string, failed?: boolean) => {
      await operations.begin(sendOp({ operationId }))
      await operations.apply(operationId, { type: "sent", txHash })
      // A flow that saw the chain turn its send down fails it with its own message.
      await operations.apply(
        operationId,
        failed ? { type: "failed", at: now, error: "dropped" } : { type: "settled", at: now },
      )
    }
    await settle("reorged", "0x1")
    await settle("revived", "0x2", true)
    await settle("final", "0x3")
    await settle("kept", "0x4")
    const monitor = new ReorgMonitor({ operationStorage: operations })
    const node = receipts({
      "0x1": { status: TxStatus.PENDING },
      "0x2": { status: TxStatus.PROPOSED, executionResult: TxExecutionResult.SUCCESS },
      "0x3": { status: TxStatus.FINALIZED, executionResult: TxExecutionResult.SUCCESS },
      "0x4": { status: TxStatus.PROPOSED, executionResult: TxExecutionResult.SUCCESS },
    })
    await monitor.runPass({ node, networkId: "net" })
    const state = async (id: string) => {
      const r = await operations.get(id)
      return [r?.state, r?.finalized ?? false]
    }
    expect(await state("reorged")).toEqual(["sent", false])
    expect(await state("revived")).toEqual(["sent", false])
    expect(await state("final")).toEqual(["settled", true])
    expect(await state("kept")).toEqual(["settled", false])
  })
})
