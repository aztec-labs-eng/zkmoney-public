import { describe, expect, it } from "vitest"
import type { ClaimFpcSubscriptionNote } from "@obsidion/sdk"
import { allowanceUsage, currentAllowanceNotes } from "../../src/core/sponsorship/allowanceUsage"

const note = (txHash: string, uses: number, refilledAt = 100n): ClaimFpcSubscriptionNote => ({
  txHash,
  blockNumber: 0,
  uses,
  refilledAt,
})

describe("allowanceUsage", () => {
  it("splits each spend by whether its tx broadcast a deposit address", () => {
    const notes = [note("send", 9), note("pool", 8), note("withdraw", 7), note("receive", 6)]
    expect(allowanceUsage(notes, 10, new Set(["pool", "receive"]))).toEqual({
      yours: 2,
      depositAddresses: 2,
    })
  })

  it("counts a batch that spent two uses as two", () => {
    // A payment link that gifts a voucher: the note between the two spends never reaches the chain.
    expect(allowanceUsage([note("subscribe", 9), note("paylink", 7)], 10, new Set())).toEqual({
      yours: 3,
      depositAddresses: 0,
    })
  })

  it("counts only the allowance held now", () => {
    const notes = [note("old", 1, 100n), note("old2", 0, 100n), note("renewal", 9, 200n)]
    expect(currentAllowanceNotes(notes).map((n) => n.txHash)).toEqual(["renewal"])
    expect(allowanceUsage(notes, 10, new Set(["old"]))).toEqual({ yours: 1, depositAddresses: 0 })
  })

  it("is empty before the first sponsored batch", () => {
    expect(allowanceUsage([], 10, new Set())).toEqual({ yours: 0, depositAddresses: 0 })
  })
})
