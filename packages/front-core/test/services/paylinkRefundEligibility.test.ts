import { describe, it, expect } from "vitest"
import { paylinkRefundEligibility } from "../../src/core/services/paylink/refundParamsFromRow"
import type { PaylinkTransaction } from "../../src/types"

// A complete, refundable PAY row: PAY action, unclaimed/unrefunded, with the
// link-borne `paylink`, the creator-only `fallbackSecret`, and the window
// timestamps. Claim window is [1000, 2000]; refund window is [creation, 1500].
const baseRow = (overrides: Partial<PaylinkTransaction> = {}): PaylinkTransaction =>
  ({
    action: "Pay To Email",
    emailPaymentAction: "Pay To Email",
    flavor: "direct",
    timestamp: Date.now(),
    status: "success",
    txHash: "0xrow",
    paylink: "https://x/#frag",
    fallbackSecret: "0xtag",
    fromClaimable: 1000,
    untilClaimable: 2000,
    refundableUntil: 1500,
    ...overrides,
  }) as PaylinkTransaction

describe("paylinkRefundEligibility", () => {
  it("eligible when expired (after the window closes)", () => {
    expect(paylinkRefundEligibility(baseRow(), 3000)).toEqual({ eligible: true })
  })

  it("eligible from creation until refundableUntil, boundary inclusive", () => {
    expect(paylinkRefundEligibility(baseRow(), 500)).toEqual({ eligible: true })
    expect(paylinkRefundEligibility(baseRow(), 1200)).toEqual({ eligible: true })
    expect(paylinkRefundEligibility(baseRow(), 1500)).toEqual({ eligible: true })
  })

  it("not eligible between the refund window closing and the claim window expiring", () => {
    expect(paylinkRefundEligibility(baseRow(), 1800)).toEqual({
      eligible: false,
      reason: "within-window",
    })
    expect(paylinkRefundEligibility(baseRow(), 2000)).toEqual({
      eligible: false,
      reason: "within-window",
    })
  })

  it("a row without a refund window is eligible only after expiry", () => {
    const row = baseRow({ refundableUntil: undefined })
    expect(paylinkRefundEligibility(row, 1200)).toEqual({
      eligible: false,
      reason: "within-window",
    })
    expect(paylinkRefundEligibility(row, 2001)).toEqual({ eligible: true })
  })

  it("not eligible when refunded", () => {
    expect(paylinkRefundEligibility(baseRow({ isRefunded: true }), 3000)).toEqual({
      eligible: false,
      reason: "refunded",
    })
  })

  it("not eligible when claimed", () => {
    expect(paylinkRefundEligibility(baseRow({ isClaimed: true }), 3000)).toEqual({
      eligible: false,
      reason: "claimed",
    })
  })

  it("refunded takes priority over claimed", () => {
    expect(paylinkRefundEligibility(baseRow({ isRefunded: true, isClaimed: true }), 3000)).toEqual({
      eligible: false,
      reason: "refunded",
    })
  })

  it("not eligible when migrated", () => {
    expect(paylinkRefundEligibility(baseRow({ isMigrated: true }), 3000)).toEqual({
      eligible: false,
      reason: "migrated",
    })
  })

  it("claimed takes priority over migrated", () => {
    expect(paylinkRefundEligibility(baseRow({ isClaimed: true, isMigrated: true }), 3000)).toEqual({
      eligible: false,
      reason: "claimed",
    })
  })

  it("not eligible for a non-PAY row (CLAIM_BACK)", () => {
    expect(
      paylinkRefundEligibility(
        baseRow({ emailPaymentAction: "Claim Back" as PaylinkTransaction["emailPaymentAction"] }),
        3000,
      ),
    ).toEqual({ eligible: false, reason: "unavailable" })
  })

  it("not eligible for a non-PAY row (REFUNDED)", () => {
    expect(
      paylinkRefundEligibility(
        baseRow({ emailPaymentAction: "Refunded" as PaylinkTransaction["emailPaymentAction"] }),
        3000,
      ),
    ).toEqual({ eligible: false, reason: "unavailable" })
  })

  it("not eligible for a legacy row missing paylink", () => {
    expect(paylinkRefundEligibility(baseRow({ paylink: undefined }), 3000)).toEqual({
      eligible: false,
      reason: "unavailable",
    })
  })

  it("not eligible for a legacy row missing fallbackSecret", () => {
    expect(paylinkRefundEligibility(baseRow({ fallbackSecret: undefined }), 3000)).toEqual({
      eligible: false,
      reason: "unavailable",
    })
  })

  it("not eligible for a legacy row missing the expiry", () => {
    expect(
      paylinkRefundEligibility(
        baseRow({ fromClaimable: undefined, untilClaimable: undefined, refundableUntil: undefined }),
        3000,
      ),
    ).toEqual({ eligible: false, reason: "unavailable" })
  })
})
