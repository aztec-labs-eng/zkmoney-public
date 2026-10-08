import { describe, expect, it } from "vitest"
import {
  depositArrivalMinutes,
  depositArrivalSeconds,
} from "../../../src/core/services/deposits/depositArrival"

const grid = { l1GenesisTime: 0, slotDuration: 36, inboxLag: 2 }

describe("depositArrivalSeconds", () => {
  it("counts sweep, lag checkpoints, the sync tick, the proof and the mining slot", () => {
    // sweep lands at 1120, in slot 31 (1116..1151); the message is filed under checkpoint 33,
    // available at the end of its slot, 34 * 36 = 1224; tick 12 + proof 60 + one slot 36 = 1332.
    expect(depositArrivalSeconds({ nowSeconds: 1000, ...grid })).toBe(1332 - 1000)
  })

  it("moves the credit by one slot when the sweep lands just after a slot boundary", () => {
    const before = 1116 - 120 - 1
    const after = 1116 - 120 + 1
    const creditedBefore = before + depositArrivalSeconds({ nowSeconds: before, ...grid })
    const creditedAfter = after + depositArrivalSeconds({ nowSeconds: after, ...grid })
    expect(creditedBefore).toBe(1296)
    expect(creditedAfter - creditedBefore).toBe(grid.slotDuration)
  })

  it("takes the caller's timings over the defaults", () => {
    const seconds = depositArrivalSeconds({
      nowSeconds: 1000,
      ...grid,
      sweepSeconds: 0,
      syncTickSeconds: 0,
      claimProofSeconds: 0,
    })
    // slot 27 (972..1007); checkpoint 29 available at 30 * 36 = 1080; mined by 1116.
    expect(seconds).toBe(1116 - 1000)
  })
})

describe("depositArrivalMinutes", () => {
  it("rounds up to whole minutes and never says less than one", () => {
    expect(depositArrivalMinutes(0)).toBe(1)
    expect(depositArrivalMinutes(60)).toBe(1)
    expect(depositArrivalMinutes(61)).toBe(2)
    expect(depositArrivalMinutes(332)).toBe(6)
  })
})
