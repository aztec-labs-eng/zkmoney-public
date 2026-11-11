/**
 * What the wallet says about the sponsored-transaction allowance, from the existing ClaimFPC reads. A
 * stored zero that may renew blocks nothing.
 */
import { describe, expect, it } from "vitest"
import { deriveAllowanceState, type AllowanceSnapshot } from "@obsidion/front-core"
import type { ClaimFpcAllowance } from "@obsidion/sdk"
import {
  allowanceRowValue,
  formatPeriod,
  sponsoredActionBlock,
} from "../../../src/features/allowance/allowanceView"

type Ready = Extract<AllowanceSnapshot, { status: "ready" }>

const ready = (over: Partial<ClaimFpcAllowance>): Ready => {
  const allowance = { subscribed: true, uses: 0, maxTx: 100, refillPeriod: 86_400, ...over }
  return {
    status: "ready",
    read: { fpcAddress: "0xf9c", railId: 1, payer: "alice", allowance },
    state: deriveAllowanceState(allowance),
    refreshing: false,
  }
}

/** A snapshot with `count` uses known to be left. */
const available = (count: number): Ready => ({
  ...ready({ uses: count }),
  state: { kind: "available", available: count, renews: true },
})

describe("sponsoredActionBlock", () => {
  it("blocks only a fresh stored zero on a rail that never renews", () => {
    expect(sponsoredActionBlock(ready({ maxTx: 1, refillPeriod: 0 }))).toBe(
      "No sponsored transactions left. This allowance does not renew.",
    )
  })

  it.each([
    ["while a new read is running", { refreshing: true }],
    ["after a failed re-read", { error: new Error("PXE down") }],
  ])("does not block on a cached refusal %s", (_, over) => {
    expect(
      sponsoredActionBlock({ ...ready({ maxTx: 1, refillPeriod: 0 }), ...over }),
    ).toBeUndefined()
  })

  it("lets through a zero that may renew, uses left, a new account, and a failed or pending read", () => {
    expect(sponsoredActionBlock(ready({}))).toBeUndefined()
    expect(sponsoredActionBlock(ready({ uses: 3 }))).toBeUndefined()
    expect(sponsoredActionBlock(ready({ subscribed: false }))).toBeUndefined()
    expect(sponsoredActionBlock({ status: "unavailable", error: new Error("x") })).toBeUndefined()
    expect(sponsoredActionBlock({ status: "loading" })).toBeUndefined()
  })
})

describe("formatPeriod", () => {
  it("states a refill period plainly", () => {
    expect(formatPeriod(86_400)).toBe("24 hours")
    expect(formatPeriod(7 * 86_400)).toBe("7 days")
    expect(formatPeriod(3_600)).toBe("1 hour")
    expect(formatPeriod(90)).toBe("90 seconds")
  })
})

describe("allowanceRowValue", () => {
  it("gives each allowance state and each read its own value, with the count when known", () => {
    const values = [
      allowanceRowValue(ready({ uses: 42 })),
      allowanceRowValue(ready({ subscribed: false })),
      allowanceRowValue(ready({})),
      allowanceRowValue(ready({ refillPeriod: 0 })),
      allowanceRowValue({ status: "unavailable", error: new Error("x") }),
      allowanceRowValue({ status: "loading" }),
    ]
    expect(new Set(values).size).toBe(values.length)
    expect(values[0]).toBe(allowanceRowValue(available(42)))
  })

  it("shows none left only for a rail that never renews, and no count for one that may", () => {
    expect(allowanceRowValue(ready({ refillPeriod: 0 }))).toBe(allowanceRowValue(available(0)))
    expect(allowanceRowValue(ready({}))).not.toBe(allowanceRowValue(available(0)))
    expect(allowanceRowValue(ready({}))).not.toMatch(/\d/)
  })
})
