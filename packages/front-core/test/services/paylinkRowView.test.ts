import { describe, expect, it } from "vitest"
import { paylinkRowView } from "../../src/core/services/paylink/paylinkRowView"
import type { PaylinkTransaction } from "../../src/types/transactions"

const NOW_SEC = 1_800_000_000
const REFUND_HASH = `0x${"cd".repeat(32)}`

function create(overrides: Partial<PaylinkTransaction> = {}): PaylinkTransaction {
  return {
    action: "Pay To Email",
    emailPaymentAction: "Pay To Email",
    flavor: "direct",
    timestamp: NOW_SEC * 1000,
    status: "success",
    txHash: `0x${"ab".repeat(32)}`,
    paylink: "https://wallet.example/link#frag",
    untilClaimable: NOW_SEC + 86_400,
    ...overrides,
  } as PaylinkTransaction
}

const claim = (status: PaylinkTransaction["status"]) =>
  create({ action: "Claim With Email", emailPaymentAction: "Claim With Email", status })

describe("paylinkRowView", () => {
  it("a pending create is a shareable paylink with no recovery", () => {
    expect(
      paylinkRowView(create({ status: "pending" }), { offer: "cancel", nowSec: NOW_SEC }),
    ).toEqual({
      title: "Paylink",
      statusLabel: "Pending",
      canShare: true,
      recovery: null,
      recovering: null,
      refunded: false,
    })
  })

  it("a pending create has nothing to share before its link exists", () => {
    const view = paylinkRowView(create({ status: "pending", paylink: undefined }), {
      nowSec: NOW_SEC,
    })
    expect(view.canShare).toBe(false)
  })

  it("a failed create offers nothing, whatever its flags say", () => {
    expect(
      paylinkRowView(create({ status: "failed" }), { offer: "reclaim", nowSec: NOW_SEC }),
    ).toEqual({
      title: "Paylink",
      statusLabel: "Failed",
      canShare: false,
      recovery: null,
      recovering: null,
      refunded: false,
    })
  })

  it("a settled unclaimed link is shareable and carries the offered recovery", () => {
    expect(paylinkRowView(create(), { offer: "cancel", nowSec: NOW_SEC })).toEqual({
      title: "Sent via paylink",
      statusLabel: "Unclaimed",
      canShare: true,
      recovery: "cancel",
      recovering: null,
      refunded: false,
    })
  })

  it("an expired link is not shareable but is reclaimable", () => {
    const view = paylinkRowView(create({ untilClaimable: NOW_SEC - 1 }), {
      offer: "reclaim",
      nowSec: NOW_SEC,
    })
    expect(view).toMatchObject({ statusLabel: "Expired", canShare: false, recovery: "reclaim" })
  })

  it("a spent link offers nothing", () => {
    for (const over of [{ isClaimed: true }, { isRefunded: true }, { isMigrated: true }]) {
      const view = paylinkRowView(create(over), { offer: "cancel", nowSec: NOW_SEC })
      expect(view).toMatchObject({ canShare: false, recovery: null, recovering: null })
    }
  })

  it("prefers the caller's fresher link status", () => {
    const view = paylinkRowView(create(), {
      linkStatus: "claimed",
      offer: "cancel",
      nowSec: NOW_SEC,
    })
    expect(view).toMatchObject({ statusLabel: "Claimed", canShare: false, recovery: null })
  })

  it("a refund in flight reads Cancelling or Reclaiming and offers nothing", () => {
    for (const refundStatus of ["pending", undefined] as const) {
      const cancelling = paylinkRowView(create({ refundTxHash: REFUND_HASH }), {
        offer: "cancel",
        refundStatus,
        nowSec: NOW_SEC,
      })
      expect(cancelling).toEqual({
        title: "Sent via paylink",
        statusLabel: "Cancelling",
        canShare: false,
        recovery: null,
        recovering: "cancel",
        refunded: false,
      })
    }
    const reclaiming = paylinkRowView(
      create({ refundTxHash: REFUND_HASH, untilClaimable: NOW_SEC - 1 }),
      {
        offer: "reclaim",
        refundStatus: "pending",
        nowSec: NOW_SEC,
      },
    )
    expect(reclaiming).toMatchObject({
      statusLabel: "Reclaiming",
      recovery: null,
      recovering: "reclaim",
    })
  })

  it("a refund this page started reads in flight before its hash reaches the row", () => {
    expect(
      paylinkRowView(create(), { offer: "cancel", refundStarting: true, nowSec: NOW_SEC }),
    ).toMatchObject({
      statusLabel: "Cancelling",
      canShare: false,
      recovery: null,
      recovering: "cancel",
    })
    // A retry over an earlier failed refund is in flight too.
    expect(
      paylinkRowView(create({ refundTxHash: REFUND_HASH }), {
        refundStatus: "failed",
        refundStarting: true,
        nowSec: NOW_SEC,
      }),
    ).toMatchObject({ statusLabel: "Cancelling", recovery: null })
  })

  it("a refund that landed reads by its recovery before the row is flagged", () => {
    expect(
      paylinkRowView(create({ refundTxHash: REFUND_HASH, refundKind: "cancel" }), {
        offer: "cancel",
        refundStatus: "success",
        nowSec: NOW_SEC,
      }),
    ).toEqual({
      title: "Sent via paylink",
      statusLabel: "Cancelled",
      canShare: false,
      recovery: null,
      recovering: null,
      refunded: true,
    })
  })

  it("a failed refund returns the link to Unclaimed with its recovery", () => {
    const view = paylinkRowView(create({ refundTxHash: REFUND_HASH }), {
      offer: "cancel",
      refundStatus: "failed",
      nowSec: NOW_SEC,
    })
    expect(view).toMatchObject({
      statusLabel: "Unclaimed",
      canShare: true,
      recovery: "cancel",
      recovering: null,
      refunded: false,
    })
  })

  it("a landed refund reads Cancelled or Reclaimed by the recovery that ran", () => {
    const landed = (over: Partial<PaylinkTransaction>) =>
      paylinkRowView(
        create({ refundTxHash: REFUND_HASH, isRefunded: true, paylink: undefined, ...over }),
        // Past expiry: a cancelled link still reads Cancelled.
        { nowSec: NOW_SEC + 2 * 86_400 },
      )
    expect(landed({ refundKind: "cancel" })).toMatchObject({
      statusLabel: "Cancelled",
      recovering: null,
      refunded: true,
    })
    expect(landed({ refundKind: "reclaim" })).toMatchObject({ statusLabel: "Reclaimed" })
    // A row refunded before the recovery was recorded.
    expect(landed({})).toMatchObject({ statusLabel: "Refunded", refunded: true })
  })

  it("a refund in flight reads the recovery the row recorded", () => {
    const view = paylinkRowView(create({ refundTxHash: REFUND_HASH, refundKind: "reclaim" }), {
      refundStatus: "pending",
      nowSec: NOW_SEC,
    })
    expect(view).toMatchObject({ statusLabel: "Reclaiming", recovering: "reclaim" })
  })

  it("a claim row is a paylink until it settles", () => {
    expect(paylinkRowView(claim("pending"), { nowSec: NOW_SEC })).toMatchObject({
      title: "Paylink",
      statusLabel: "Pending",
      canShare: false,
    })
    expect(paylinkRowView(claim("success"), { nowSec: NOW_SEC })).toEqual({
      title: "Received via paylink",
      canShare: false,
      recovery: null,
      recovering: null,
      refunded: false,
    })
  })

  it("reads a retry by the recovery it runs now, not a failed try's recorded kind", () => {
    const expired = create({ untilClaimable: NOW_SEC - 1, refundKind: "cancel" })
    expect(paylinkRowView(expired, { refundStarting: true, nowSec: NOW_SEC }).statusLabel).toBe(
      "Reclaiming",
    )
    const failedTry = { ...expired, refundTxHash: REFUND_HASH }
    expect(
      paylinkRowView(failedTry, { refundStarting: true, refundStatus: "failed", nowSec: NOW_SEC })
        .statusLabel,
    ).toBe("Reclaiming")
  })

  it("keeps a submitted cancel reading Cancelling once the claim window closes", () => {
    const submitted = create({
      untilClaimable: NOW_SEC - 1,
      refundTxHash: REFUND_HASH,
      refundKind: "cancel",
    })
    expect(
      paylinkRowView(submitted, { refundStarting: true, refundStatus: "pending", nowSec: NOW_SEC })
        .statusLabel,
    ).toBe("Cancelling")
  })
})
