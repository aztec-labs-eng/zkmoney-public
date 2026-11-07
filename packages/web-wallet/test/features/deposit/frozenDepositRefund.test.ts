import { describe, expect, it } from "vitest"
import type { FrozenRefundCandidate } from "@obsidion/sdk"
import { pickFrozenDeposits } from "../../../src/features/deposit/recovery/frozenDepositRefund"

describe("pickFrozenDeposits", () => {
  it("takes only this address's deposits, never notes or another address's deposits", () => {
    const candidates: FrozenRefundCandidate[] = [
      { id: "n1", amount: "5", kind: "note" },
      { id: "e1", amount: "5", kind: "escrow-note", owner: "0xescrow" },
      { id: "d1", amount: "10", kind: "frozen-deposit", leafIndex: "10" },
      { id: "d2", amount: "7", kind: "frozen-deposit", leafIndex: "11" },
      { id: "u1", amount: "3", kind: "unprocessed-deposit", leafIndex: "12" },
    ]

    expect(pickFrozenDeposits(candidates, ["10", "12"]).map((c) => c.id)).toEqual(["d1", "u1"])
    expect(pickFrozenDeposits(candidates, ["99"])).toEqual([])
  })
})
