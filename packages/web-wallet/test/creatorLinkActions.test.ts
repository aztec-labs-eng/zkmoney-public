/**
 * The detail modal's creator-recovery gate: which of "Reclaim funds" / "Cancel link" a stored PAY
 * row offers — Cancel inside the refund window, Reclaim after expiry — across lifecycle flags, the
 * on-open status refresh, and whether the session's account is the row's creator.
 */
import { describe, expect, it } from "vitest"
import type { PaylinkStatusKind, PaylinkTransaction } from "@obsidion/front-core"
import {
  creatorLinkAction,
  paylinkStatusIsUnspent,
} from "../src/features/paylink/creatorLinkActions"

const CREATOR = `0x${"22".repeat(32)}`
const OTHER = `0x${"33".repeat(32)}`
const NOW = 1_800_000_000

/**
 * A complete creator create row: claim window open, refund window already closed, nothing spent,
 * refund material intact. Overrides open the refund window or expire the link.
 */
function payRow(over: Partial<PaylinkTransaction> = {}): PaylinkTransaction {
  return {
    action: "Pay To Email",
    emailPaymentAction: "Pay To Email",
    flavor: "direct",
    status: "success",
    timestamp: NOW * 1000,
    txHash: `0x${"ab".repeat(32)}`,
    paylink: "https://wallet.example/link#frag",
    payToEmailSecret: `0x${"44".repeat(32)}`,
    fallbackSecret: `0x${"55".repeat(32)}`,
    obsidionAccountAddress: CREATOR,
    fromClaimable: 0,
    untilClaimable: NOW + 86_400,
    refundableUntil: NOW - 1,
    ...over,
  } as PaylinkTransaction
}

const gate = (
  row: PaylinkTransaction,
  liveStatus: PaylinkStatusKind = "awaitingClaim",
  account = CREATOR,
) => creatorLinkAction(row, { nowSec: NOW, liveStatus, account })

describe("paylinkStatusIsUnspent", () => {
  it("admits only the statuses whose escrow still holds funds", () => {
    expect(paylinkStatusIsUnspent("awaitingClaim")).toBe(true)
    expect(paylinkStatusIsUnspent("expired")).toBe(true)
    expect(paylinkStatusIsUnspent("claimed")).toBe(false)
    expect(paylinkStatusIsUnspent("refunded")).toBe(false)
    expect(paylinkStatusIsUnspent("migrated")).toBe(false)
  })
})

describe("creatorLinkAction", () => {
  it("offers cancel inside the refund window, even while the link is claimable", () => {
    expect(gate(payRow({ refundableUntil: NOW + 60 }))).toBe("cancel")
    expect(gate(payRow({ flavor: "email", refundableUntil: NOW + 60 }))).toBe("cancel")
  })

  it("offers nothing once the refund window has closed and the link is still claimable", () => {
    expect(gate(payRow())).toBeNull()
    expect(gate(payRow({ flavor: "email" }))).toBeNull()
  })

  it("offers nothing to a row without a persisted refund window until it expires", () => {
    const row = payRow({ refundableUntil: undefined })
    expect(gate(row)).toBeNull()
    expect(gate(payRow({ ...row, untilClaimable: NOW - 1 }), "expired")).toBe("reclaim")
  })

  it("offers reclaim on a link past its window", () => {
    expect(gate(payRow({ untilClaimable: NOW - 1 }), "expired")).toBe("reclaim")
    expect(gate(payRow({ flavor: "email", untilClaimable: NOW - 1 }), "expired")).toBe("reclaim")
  })

  it("offers nothing once the row itself says the escrow is spent", () => {
    const expiredEmail = { flavor: "email" as const, untilClaimable: NOW - 1 }
    expect(gate(payRow({ ...expiredEmail, isClaimed: true }), "claimed")).toBeNull()
    expect(gate(payRow({ ...expiredEmail, isRefunded: true }), "refunded")).toBeNull()
    expect(gate(payRow({ ...expiredEmail, isMigrated: true }), "migrated")).toBeNull()
    expect(gate(payRow({ isClaimed: true }), "claimed")).toBeNull()
  })

  it("withdraws the CTA when the on-open refresh finds the link claimed", () => {
    // The row's own flags still read unclaimed — web has no reconciler, so this is the only signal.
    expect(gate(payRow({ refundableUntil: NOW + 60 }), "claimed")).toBeNull()
    expect(gate(payRow({ flavor: "email", untilClaimable: NOW - 1 }), "claimed")).toBeNull()
  })

  it("offers nothing to an account that is not the row's creator", () => {
    expect(gate(payRow({ refundableUntil: NOW + 60 }), "awaitingClaim", OTHER)).toBeNull()
    expect(gate(payRow({ flavor: "email", untilClaimable: NOW - 1 }), "expired", OTHER)).toBeNull()
  })

  it("keeps the offer when the session account is not known yet", () => {
    expect(
      creatorLinkAction(payRow({ refundableUntil: NOW + 60 }), {
        nowSec: NOW,
        liveStatus: "awaitingClaim",
      }),
    ).toBe("cancel")
  })

  it("offers nothing on a failed create, which escrowed nothing", () => {
    expect(gate(payRow({ status: "failed", refundableUntil: NOW + 60 }))).toBeNull()
  })

  it("offers nothing without the material a recovery needs", () => {
    expect(gate(payRow({ refundableUntil: NOW + 60, paylink: undefined }))).toBeNull()
    expect(gate(payRow({ refundableUntil: NOW + 60, fallbackSecret: undefined }))).toBeNull()
    expect(gate(payRow({ refundableUntil: NOW + 60, untilClaimable: undefined }))).toBeNull()
  })

  it("offers nothing on a claim or refund leg, only on the create row", () => {
    expect(
      gate(payRow({ refundableUntil: NOW + 60, emailPaymentAction: "Claim With Email" })),
    ).toBeNull()
    expect(gate(payRow({ untilClaimable: NOW - 1, emailPaymentAction: "Claim Back" }))).toBeNull()
  })

  it("offers nothing on a zk-flavored row, which web never creates", () => {
    expect(gate(payRow({ flavor: "zk", untilClaimable: NOW - 1 }), "expired")).toBeNull()
  })

  it("withholds cancel inside the proving margin before refundableUntil", () => {
    expect(gate(payRow({ refundableUntil: NOW + 31 }))).toBe("cancel")
    expect(gate(payRow({ refundableUntil: NOW + 30 }))).toBeNull()
    expect(gate(payRow({ refundableUntil: NOW + 1 }))).toBeNull()
  })

  it("reads the window at the time it is handed, so chain time decides", () => {
    const row = payRow({ flavor: "email", refundableUntil: NOW + 60, untilClaimable: NOW + 60 })
    expect(creatorLinkAction(row, { nowSec: NOW, liveStatus: "awaitingClaim" })).toBe("cancel")
    expect(creatorLinkAction(row, { nowSec: NOW + 31, liveStatus: "awaitingClaim" })).toBeNull()
    expect(creatorLinkAction(row, { nowSec: NOW + 60, liveStatus: "awaitingClaim" })).toBeNull()
    expect(creatorLinkAction(row, { nowSec: NOW + 61, liveStatus: "expired" })).toBe("reclaim")
  })
})
