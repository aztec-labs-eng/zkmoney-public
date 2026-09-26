import { describe, expect, it } from "vitest"
import { paylinkStatusFor } from "../../src/core/services/paylink/paylinkStatus"
import type { PaylinkTransaction } from "../../src/types/transactions"

const NOW_SEC = 1_800_000_000

function row(overrides: Partial<PaylinkTransaction>): PaylinkTransaction {
  return {
    action: "Pay To Email",
    emailPaymentAction: "Pay To Email",
    flavor: "direct",
    timestamp: NOW_SEC * 1000,
    status: "success",
    txHash: `0x${"ab".repeat(32)}`,
    ...overrides,
  } as PaylinkTransaction
}

describe("paylinkStatusFor", () => {
  it("defaults to awaitingClaim", () => {
    expect(paylinkStatusFor(row({}), NOW_SEC)).toBe("awaitingClaim")
  })

  it("expired when unclaimed past untilClaimable", () => {
    expect(paylinkStatusFor(row({ untilClaimable: NOW_SEC - 1 }), NOW_SEC)).toBe("expired")
    expect(paylinkStatusFor(row({ untilClaimable: NOW_SEC + 60 }), NOW_SEC)).toBe("awaitingClaim")
  })

  it("refunded beats claimed beats migrated beats expired", () => {
    const all = {
      isRefunded: true,
      isClaimed: true,
      isMigrated: true,
      untilClaimable: NOW_SEC - 1,
    }
    expect(paylinkStatusFor(row(all), NOW_SEC)).toBe("refunded")
    expect(paylinkStatusFor(row({ ...all, isRefunded: false }), NOW_SEC)).toBe("claimed")
    expect(paylinkStatusFor(row({ ...all, isRefunded: false, isClaimed: false }), NOW_SEC)).toBe(
      "migrated",
    )
  })
})
