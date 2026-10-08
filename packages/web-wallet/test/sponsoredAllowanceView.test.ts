/**
 * What the wallet says about the sponsored-transaction allowance, from the existing ClaimFPC reads. A
 * stored zero that may renew reads as unknown and blocks nothing. Nothing states a renewal date or
 * countdown, calls the allowance daily, or calls it a limit on funds.
 */
import { describe, expect, it } from "vitest"
import { deriveAllowanceState, type AllowanceSnapshot } from "@obsidion/front-core"
import type { ClaimFpcAllowance } from "@obsidion/sdk"
import {
  ALLOWANCE_SCOPE,
  allowanceView,
  formatPeriod,
  sponsoredActionBlock,
} from "../src/features/allowance/allowanceView"

type Ready = Extract<AllowanceSnapshot, { status: "ready" }>

const ready = (over: Partial<ClaimFpcAllowance>): Ready => {
  const allowance = { subscribed: true, uses: 0, maxTx: 100, refillPeriod: 86_400, ...over }
  return {
    status: "ready",
    scope: "alice|sandbox",
    read: { fpcAddress: "0xf9c", railId: 1, allowance },
    state: deriveAllowanceState(allowance),
    refreshing: false,
  }
}

describe("allowanceView", () => {
  it("gives every state its own reading", () => {
    const views = [
      allowanceView(ready({ subscribed: false })),
      allowanceView(ready({ uses: 12 })),
      allowanceView(ready({})),
      allowanceView(ready({ maxTx: 1, refillPeriod: 0 })),
      allowanceView({ status: "unavailable", scope: "alice|sandbox", error: new Error("x") }),
      allowanceView({ status: "loading", scope: "alice|sandbox" }),
    ]
    expect(views.map((view) => view.state)).toEqual([
      "not-subscribed",
      "available",
      "renewal-unknown",
      "does-not-renew",
      "unavailable",
      "loading",
    ])
    expect(new Set(views.map((view) => view.headline)).size).toBe(views.length)
    for (const view of views) {
      expect(`${view.headline} ${view.detail}`).not.toMatch(
        /daily|per day|midnight|eligible in|about \d|\d+ (min|h)\b/i,
      )
    }
  })

  it("says how many are left, concisely", () => {
    expect(allowanceView(ready({ uses: 12 })).headline).toBe("12 sponsored transactions left")
    expect(allowanceView(ready({ uses: 1 })).headline).toBe("1 sponsored transaction left")
  })

  it("calls a stored zero on a renewing rail unknown and says the next action may renew it", () => {
    const view = allowanceView(ready({}))
    expect(view.headline).toBe("Renewal status unknown")
    expect(view.detail).toMatch(/next sponsored transaction may start a new allowance of 100/)
    expect(view.detail).toMatch(/renews 24 hours after it started, once used up/)
    expect(view.tone).toBe("normal")
  })

  it("explains the configured allowance and renewal period without a date", () => {
    expect(allowanceView(ready({ subscribed: false })).detail).toBe(
      "Your first sponsored transaction starts an allowance of 100. " +
        "An allowance renews 24 hours after it started, once used up.",
    )
    expect(allowanceView(ready({ subscribed: false, maxTx: 1, refillPeriod: 0 })).detail).toBe(
      "Your first sponsored transaction starts an allowance of 1. It does not renew.",
    )
  })

  it("shows a stored zero on a rail that never renews as exhausted", () => {
    const view = allowanceView(ready({ maxTx: 1, refillPeriod: 0 }))
    expect(view.headline).toBe("No sponsored transactions left")
    expect(view.detail).toBe("This allowance does not renew.")
    expect(view.tone).toBe("warning")
  })

  it("offers a retry only when the read failed", () => {
    expect(allowanceView({ status: "unavailable", scope: "a", error: new Error("x") }).retry).toBe(
      true,
    )
    expect(allowanceView(ready({})).retry).toBe(false)
  })

  it("explains the allowance counts transactions, not their value", () => {
    expect(ALLOWANCE_SCOPE).toMatch(/counts transactions, not their value/)
    expect(ALLOWANCE_SCOPE).toMatch(/deposit addresses/)
    expect(ALLOWANCE_SCOPE.replace("zk.money", "")).not.toMatch(/money/i)
  })
})

describe("sponsoredActionBlock", () => {
  it("blocks only a fresh stored zero on a rail that never renews", () => {
    expect(sponsoredActionBlock(ready({ maxTx: 1, refillPeriod: 0 }))).toBe(
      "No sponsored transactions left. This allowance does not renew.",
    )
  })

  it("does not block on a cached refusal while a new read is running", () => {
    expect(
      sponsoredActionBlock({ ...ready({ maxTx: 1, refillPeriod: 0 }), refreshing: true }),
    ).toBeUndefined()
  })

  it("lets through a zero that may renew, uses left, a new account, and a failed or pending read", () => {
    expect(sponsoredActionBlock(ready({}))).toBeUndefined()
    expect(sponsoredActionBlock(ready({ uses: 3 }))).toBeUndefined()
    expect(sponsoredActionBlock(ready({ subscribed: false }))).toBeUndefined()
    expect(
      sponsoredActionBlock({ status: "unavailable", scope: "a", error: new Error("x") }),
    ).toBeUndefined()
    expect(sponsoredActionBlock({ status: "loading", scope: "a" })).toBeUndefined()
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
