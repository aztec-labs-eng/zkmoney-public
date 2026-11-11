// @vitest-environment node
/** A request link's publish is no payment: its bell row opens the request it publishes. */
import { describe, expect, it } from "vitest"
import type { OperationRecord } from "../../src/engine/operationTransition"
import {
  requestLinkOperationId,
  selectNotifications,
  type NotificationSources,
} from "../../src/engine/notificationFeed"

const NOW = 1_800_000_000_000

const op = (over: Partial<OperationRecord>): OperationRecord => ({
  operationId: "op1",
  flow: "request-link",
  summary: "Request",
  state: "settled",
  txHash: "0xS1",
  startedAt: NOW - 2_000,
  endedAt: NOW - 1_000,
  ...over,
})

const targetOf = (record: OperationRecord) => {
  const sources: NotificationSources = {
    rows: [],
    links: [],
    oldVersionWithdrawals: [],
    bridgeIns: { records: [], hydrated: true },
    deposits: { records: [], hydrated: true },
    withdrawals: { records: [], hydrated: true },
    upgrades: { items: [], recipients: new Set(), loaded: true },
    processing: new Map(),
    registrations: [],
    operations: { ended: [record], running: [] },
    loaded: true,
  }
  const [entry] = selectNotifications(sources, new Map(), new Map(), NOW)
  return entry?.target
}

describe("request link operations", () => {
  it("gives each publish of one request its own id", () => {
    const first = requestLinkOperationId("0x0a1b")
    expect(first).toMatch(/^request-link_0x0a1b_/)
    expect(requestLinkOperationId("0x0a1b")).not.toBe(first)
  })

  it("opens the request a settled or failed publish carries", () => {
    const operationId = requestLinkOperationId("0x0a1b")
    for (const state of ["settled", "failed"] as const) {
      expect(targetOf(op({ operationId, state }))).toEqual({
        type: "request.share",
        requestId: "0x0a1b",
      })
    }
  })

  it("opens the transfer when the id names no request", () => {
    expect(targetOf(op({ operationId: "request-link_none" }))).toEqual({
      type: "transfer.txDetail",
      txHash: "0xS1",
    })
  })

  it("reads no request out of another flow's id", () => {
    const operationId = requestLinkOperationId("0x0a1b")
    expect(targetOf(op({ operationId, flow: "send", state: "failed" }))).toEqual({
      type: "transfer.pending",
    })
  })
})
