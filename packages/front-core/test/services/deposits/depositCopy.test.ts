import { describe, expect, it } from "vitest"
import { depositPhaseCopy } from "../../../src/core/services/deposits/depositCopy"
import type { SIPADepositRecord } from "../../../src/core/services/deposits/SIPADepositStore"

const swept = {
  sipaAddress: `0x${"11".repeat(20)}`,
  phase: "pendingClaim",
  amount: "10",
  netAmount: "10000000000000000000",
  sweepTxHash: `0x${"22".repeat(32)}`,
  startTime: 0,
} as SIPADepositRecord

describe("deposit phase copy", () => {
  it("names a swept deposit on a frozen portal refundable, with no live row", () => {
    expect(depositPhaseCopy(swept).live).toBe("Crediting")
    expect(depositPhaseCopy(swept, { portalFrozen: true })).toEqual({
      pill: "Refundable",
      status: "Refund it with Withdraw",
    })
  })
})
