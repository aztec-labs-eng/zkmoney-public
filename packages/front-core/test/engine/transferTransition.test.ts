import { describe, expect, it } from "vitest"
import { QueueStatus } from "@obsidion/core/constants"
import {
  keepOwned,
  transferTransition,
  type TransferEvent,
} from "../../src/engine/transferTransition"
import type { Transaction } from "../../src/types/transactions"

const base = { id: "r", timestamp: 1, amountAtomic: 0n, action: "send" } as Transaction

const states: Record<string, Partial<Transaction>> = {
  unsent: { status: "pending", txHash: "", detailedStatus: QueueStatus.PENDING },
  sent: { status: "pending", txHash: "0xh", detailedStatus: QueueStatus.MINING },
  success: { status: "success", txHash: "0xh", detailedStatus: QueueStatus.SUCCESS },
  failed: { status: "failed", txHash: "0xh", detailedStatus: QueueStatus.FAILED },
  demoted: { status: "pending", txHash: "0xh", detailedStatus: QueueStatus.PENDING, reorgEpoch: 1 },
  cancelled: { status: "failed", txHash: "", detailedStatus: QueueStatus.CANCELLED },
}

const S = QueueStatus.SUCCESS
const F = QueueStatus.FAILED
const events: Record<string, TransferEvent> = {
  "interrupted": { type: "interrupted" },
  "confirmed ok": { type: "confirmed", at: 5, status: S },
  "confirmed ok@1": { type: "confirmed", at: 5, status: S, epoch: 1 },
  "confirmed failed": { type: "confirmed", at: 5, status: F },
  "demoted": { type: "demoted", at: 5 },
  "demoted failed": { type: "demoted", at: 5, terminal: "failed" },
  "anchored": { type: "anchored", tier: "proposed" as Transaction["tier"], blockNumber: 7 },
}

// `status detailedStatus epoch`, or "-" when the row is left as it is.
const P = "pending pending"
const expected: Record<string, Record<string, string>> = {
  "interrupted": {
    unsent: "failed failed 0",
    sent: "-",
    success: "-",
    failed: "-",
    demoted: "-",
    cancelled: "-",
  },
  "confirmed ok": {
    unsent: "-",
    sent: "success success 0",
    success: "success success 0",
    failed: "success success 0",
    demoted: "-",
    cancelled: "-",
  },
  "confirmed ok@1": {
    unsent: "-",
    sent: "-",
    success: "-",
    failed: "-",
    demoted: "success success 1",
    cancelled: "-",
  },
  "confirmed failed": {
    unsent: "failed failed 0",
    sent: "failed failed 0",
    success: "failed failed 0",
    failed: "failed failed 0",
    demoted: "-",
    cancelled: "-",
  },
  "demoted": {
    unsent: `${P} 1`,
    sent: `${P} 1`,
    success: `${P} 1`,
    failed: `${P} 1`,
    demoted: `${P} 2`,
    cancelled: "-",
  },
  "demoted failed": {
    unsent: "failed failed 1",
    sent: "failed failed 1",
    success: "failed failed 1",
    failed: "failed failed 1",
    demoted: "failed failed 2",
    cancelled: "-",
  },
  "anchored": {
    unsent: "pending pending 0",
    sent: "pending mining 0",
    success: "success success 0",
    failed: "failed failed 0",
    demoted: `${P} 1`,
    cancelled: "-",
  },
}

const summary = (row: Transaction | undefined) =>
  row ? `${row.status} ${row.detailedStatus} ${row.reorgEpoch ?? 0}` : "-"

describe("activity transition: status", () => {
  for (const [eventName, event] of Object.entries(events)) {
    for (const [stateName, state] of Object.entries(states)) {
      it(`${eventName} on ${stateName}`, () => {
        const next = transferTransition({ ...base, ...state } as Transaction, event)
        expect(summary(next)).toBe(expected[eventName][stateName])
      })
    }
  }
})

describe("keepOwned", () => {
  it("keeps every field a transition owns, and takes the rest", () => {
    const row = { ...base, status: "success", reorgEpoch: 2, tier: "proposed" } as Transaction
    const next = keepOwned(row, {
      ...row,
      reorgEpoch: 0,
      status: "failed",
      memo: "hi",
    } as Transaction)
    expect(next).toMatchObject({ reorgEpoch: 2, status: "success", tier: "proposed", memo: "hi" })
  })
})
