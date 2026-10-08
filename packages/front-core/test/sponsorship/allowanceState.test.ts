/**
 * The allowance states the existing ClaimFPC reads can prove. A stored zero on a rail that renews is
 * unknown, because only the next batch finds out whether it starts a new allowance, so it never
 * blocks. Only a stored zero on a rail that never renews is exhausted for good.
 */
import { describe, expect, it } from "vitest"
import type { ClaimFpcAllowance } from "@obsidion/sdk"
import {
  allowanceBlocksSponsoredAction,
  allowanceCovers,
  deriveAllowanceState,
} from "../../src/core/sponsorship"

const DAY = 86_400

const allowance = (over: Partial<ClaimFpcAllowance>): ClaimFpcAllowance => ({
  subscribed: true,
  uses: 0,
  maxTx: 100,
  refillPeriod: DAY,
  ...over,
})

describe("deriveAllowanceState", () => {
  it("tells no subscription apart from a stored zero", () => {
    const state = deriveAllowanceState(allowance({ subscribed: false }))
    expect(state).toEqual({ kind: "not-subscribed", maxTx: 100, renews: true })
    expect(allowanceBlocksSponsoredAction(state)).toBe(false)
  })

  it("counts stored uses", () => {
    expect(deriveAllowanceState(allowance({ uses: 7 }))).toEqual({
      kind: "available",
      available: 7,
      renews: true,
    })
    expect(deriveAllowanceState(allowance({ uses: 1, maxTx: 1, refillPeriod: 0 }))).toEqual({
      kind: "available",
      available: 1,
      renews: false,
    })
  })

  it("leaves a stored zero on a renewing rail unknown, without blocking", () => {
    const state = deriveAllowanceState(allowance({}))
    expect(state).toEqual({ kind: "renewal-unknown", maxTx: 100 })
    expect(allowanceBlocksSponsoredAction(state)).toBe(false)
  })

  it("treats a stored zero on a rail that never renews as exhausted", () => {
    const state = deriveAllowanceState(allowance({ maxTx: 1, refillPeriod: 0 }))
    expect(state).toEqual({ kind: "does-not-renew" })
    expect(allowanceBlocksSponsoredAction(state)).toBe(true)
  })
})

describe("allowanceCovers", () => {
  it("counts a gift as a second use beside the batch that carries it", () => {
    expect(allowanceCovers({ kind: "available", available: 2, renews: true }, 2)).toBe(true)
    expect(allowanceCovers({ kind: "available", available: 1, renews: true }, 2)).toBe(false)
  })

  it("opens a subscription's whole allowance, first use included", () => {
    expect(allowanceCovers({ kind: "not-subscribed", maxTx: 100, renews: true }, 2)).toBe(true)
    expect(allowanceCovers({ kind: "not-subscribed", maxTx: 1, renews: false }, 2)).toBe(false)
  })

  it("covers nothing on a stored zero, renewing or not", () => {
    expect(allowanceCovers({ kind: "renewal-unknown", maxTx: 100 }, 1)).toBe(false)
    expect(allowanceCovers({ kind: "does-not-renew" }, 1)).toBe(false)
  })
})
