import { describe, expect, it } from "vitest"
import { selectFeed, type FeedItem, type FeedSources } from "../../src/engine/activityFeed"
import { buildActivityCsvRows } from "../../src/core/services/activity/activityCsv"
import { paylinkRowView } from "../../src/core/services/paylink/paylinkRowView"
import { FUNDING_STATUS, operationIndex, withOperation } from "../../src/engine/operations"
import type { PaylinkRecord } from "../../src/engine/paylinkTransition"
import type { Transaction } from "../../src/types/transactions"
import type { OperationRecord } from "../../src/engine/operationTransition"

const op = (over: Partial<OperationRecord> = {}): OperationRecord =>
  ({
    operationId: "op",
    flow: "paylink-create",
    summary: "",
    state: "local",
    startedAt: 1,
    ...over,
  } as OperationRecord)

describe("withOperation", () => {
  it.each([
    ["local", "local"],
    ["sent", "sent"],
    ["settled", "settled"],
    ["failed", "failed"],
  ] as const)("reads a record's funding off its %s operation, by id", (state, funding) => {
    const joined = withOperation(
      { operationId: "op", txHash: "0xh" },
      operationIndex([op({ state })]),
    )
    expect(joined).toMatchObject({ funding, op: { state } })
  })

  it("finds the operation by hash for a record that does not name it", () => {
    const index = operationIndex([op({ state: "failed", txHash: "0xH" })])
    expect(withOperation({ txHash: "0xh" }, index).funding).toBe("failed")
  })

  it("reads a record with no operation off its own hash", () => {
    const none = operationIndex([])
    expect(withOperation({ txHash: "0xh" }, none)).toEqual({
      record: { txHash: "0xh" },
      funding: "settled",
    })
    expect(withOperation({ operationId: "gone" }, none).funding).toBe("unsent")
  })

  it("leaves an operation no record names out of every join", () => {
    const index = operationIndex([op({ operationId: "other", txHash: "0xo" })])
    expect(withOperation({ operationId: "op", txHash: "0xh" }, index).op).toBeUndefined()
  })
})

const set = <R>(records: R[], over: { loaded?: boolean; failed?: boolean } = {}) => ({
  records,
  loaded: true,
  failed: false,
  ...over,
})
const H = `0x${"0a".repeat(32)}`
const token = { address: "0xt", name: "D", symbol: "D", decimals: 6, logo: "", amount: 1, price: 1 }
const link: PaylinkRecord = {
  id: "l",
  operationId: "op",
  txHash: H,
  timestamp: 1,
  amountAtomic: 1_000_000n,
  token,
  flavor: "direct",
  payToEmailSecret: "0xs",
}
const funding = (status: Transaction["status"]) =>
  ({
    id: H,
    action: "send",
    token,
    amountAtomic: 1_000_000n,
    timestamp: 2,
    status,
    txHash: H,
  } as Transaction)

function feed(over: Partial<FeedSources>) {
  const sources: FeedSources = {
    rows: set([]),
    links: set([link]),
    operations: set([op({ state: "settled", txHash: H, endedAt: 2 })]),
    requests: [],
    deposits: set([]),
    withdrawals: { records: [], hydrated: true },
    bridgeIns: { records: [], hydrated: true },
    upgrades: { items: [], recipients: new Set(), loaded: true },
    moves: { records: [], hydrated: true },
    oldVersionWithdrawals: [],
    processing: new Map(),
    refunding: new Set(),
    catchingUp: false,
    now: 1_000,
    ...over,
  }
  const contacts = { rows: [], hydrated: true, failed: false }
  return selectFeed(sources, { contacts, registrations: { records: [] } })
}

const linkItem = (items: readonly FeedItem[]) =>
  items.find((i): i is Extract<FeedItem, { kind: "link" }> => i.kind === "link")

describe("a link in the feed", () => {
  it.each(["local", "sent", "settled", "failed"] as const)(
    "reads its %s operation alone, whatever its funding's chain row says",
    (state) => {
      const status = FUNDING_STATUS[state]
      const shown = paylinkRowView(link, { status, create: true, nowSec: 1 }).statusLabel
      for (const chain of ["pending", "success", "failed"] as const) {
        const f = feed({ rows: set([funding(chain)]), operations: set([op({ state, txHash: H })]) })
        const item = linkItem(f.items)
        expect(item).toMatchObject({ funding: state, view: { statusLabel: shown } })
        expect(f.csv.links[0].status).toBe(status)
        expect(f.items).toHaveLength(1)
      }
    },
  )

  it("is not hydrated while the links or the operations are unread or failed", () => {
    expect(feed({}).hydrated).toBe(true)
    expect(feed({ links: set([], { loaded: false }) }).hydrated).toBe(false)
    expect(feed({ operations: set([], { failed: true }) }).hydrated).toBe(false)
  })

  it("hides an older build's unsent funding row, matched by its operation", () => {
    const unsent = { ...link, txHash: undefined }
    const row = { ...funding("pending"), id: "op", operationId: "op", txHash: "" }
    const f = feed({ rows: set([row]), links: set([unsent]), operations: set([]) })
    expect(f.items.map((i) => i.kind)).toEqual(["link"])
    const rows = buildActivityCsvRows({ ...f.csv, walletToken: { symbol: "D", decimals: 6 } })
    expect(rows).toEqual([])
  })

  it("is one export row, its funding transfer left out", () => {
    const { csv } = feed({ rows: set([funding("success")]) })
    const rows = buildActivityCsvRows({ ...csv, walletToken: { symbol: "D", decimals: 6 } })
    expect(rows.map((r) => r.aztecTxHash)).toEqual([H])
  })
})
