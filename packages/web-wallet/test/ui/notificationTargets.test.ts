/** A notification's target becomes `/activity` router state, which the feed resolves back to a row. */
import { describe, expect, it, vi } from "vitest"
import type { NotificationEntry } from "@obsidion/front-core"

vi.mock("@obsidion/web-ds", () => ({
  ActivityListRow: () => null,
  GradientInitialAvatar: () => null,
  Icon: () => null,
  avatarColors: () => ["#000", "#fff"],
}))

/** Whether the open registration is one a payment link funds. */
const ticket = vi.hoisted(() => ({ value: false }))
vi.mock("../../src/features/paylink/ticketContinuation", () => ({
  pendingTicketRegistration: () => ticket.value,
  ticketSignupCommitted: () => false,
}))

const { notificationRoute } = await import("../../src/ui/NotificationsPanel/NotificationsPanel")
/** The session the route reads; the mocked ticket check reads nothing of it. */
const session = {} as never
const { detailNoticeFor } = await import(
  "../../src/ui/activity/ActivityDetailHost/ActivityDetailHost"
)

const SIPA = "0xAbCdEf0000000000000000000000000000000001"

function entry(target: NotificationEntry["target"]): NotificationEntry {
  return {
    id: "x",
    about: {
      kind: "event",
      event: { id: "x", at: 0, kind: "claimReversed", data: { txHash: "0x" } },
    },
    timestampMs: 0,
    icon: "",
    severity: "info",
    pending: false,
    read: false,
    firstSeenAt: 0,
    target,
  }
}

describe("notification target -> activity detail", () => {
  it("opens a request link's publish at its request's sheet, as it has no activity row", () => {
    expect(
      notificationRoute(entry({ type: "request.share", requestId: "0x0a1b" }), session),
    ).toEqual({
      to: "/activity",
      state: { openRequestId: "0x0a1b" },
    })
  })

  it("routes bridge targets by kind and tx targets by hash", () => {
    expect(
      notificationRoute(
        entry({ type: "bridge.txDetail", bridgeKind: "withdrawal", sourceId: "w1" }),
        session,
      ),
    ).toMatchObject({ to: "/activity", state: { openWithdrawalId: "w1" } })
    expect(
      notificationRoute(
        entry({ type: "bridge.txDetail", bridgeKind: "deposit", sourceId: SIPA.toLowerCase() }),
        session,
      ),
    ).toMatchObject({ to: "/activity", state: { openDepositAddress: SIPA.toLowerCase() } })
    expect(
      notificationRoute(entry({ type: "transfer.txDetail", txHash: "0xt" }), session),
    ).toMatchObject({
      to: "/activity",
      state: { openTxHash: "0xt" },
    })
  })

  it("asks for a link recheck from a sent link's entry, and from no other", () => {
    for (const type of ["paylink.claimed", "paylink.reclaimable"] as const)
      expect(notificationRoute(entry({ type, txHash: "0xl" }), session)).toMatchObject({
        state: { openTxHash: "0xl" },
        recheckLinks: true,
      })
    expect(
      notificationRoute(entry({ type: "transfer.txDetail", txHash: "0xt" }), session),
    ).not.toHaveProperty("recheckLinks")
  })

  it("outdates a reorg failure notice once its row confirms; a confirmation notice never", () => {
    const reorg = { type: "reorg.txDetail", txHash: "0xt" } as const
    expect(notificationRoute({ ...entry(reorg), severity: "error" }, session)?.state).toMatchObject(
      {
        openTxHash: "0xt",
        noticeStaleOn: "success",
      },
    )
    expect(
      notificationRoute({ ...entry(reorg), severity: "success" }, session)?.state,
    ).not.toHaveProperty("noticeStaleOn")
  })

  it("keeps a failure notice while the row is failed or demoted, drops it once confirmed", () => {
    const failed = { text: "Payment failed: …", staleOn: "success" as const }
    expect(detailNoticeFor(failed, { status: "failed" })).toBe("Payment failed: …")
    // A grace-expired alert fires while the demoted row is still pending.
    expect(detailNoticeFor(failed, { status: "pending" })).toBe("Payment failed: …")
    expect(detailNoticeFor(failed, { status: "success" })).toBeUndefined()
    expect(detailNoticeFor({ text: "Transfer received" }, { status: "success" })).toBe(
      "Transfer received",
    )
  })

  it("opens a mutual-add notice on the contact page", () => {
    expect(notificationRoute(entry({ type: "contact.added", contactId: "bob" }), session)).toEqual({
      to: "/contacts/bob",
    })
    expect(
      notificationRoute(entry({ type: "contact.added" } as NotificationEntry["target"]), session),
    ).toBeNull()
  })

  it("opens the migration dialog, in place, for funds left on an old version", () => {
    expect(notificationRoute(entry({ type: "migration.residuals" }), session)).toEqual({
      migration: "residuals",
    })
  })

  it("opens an upgrade's run in activity", () => {
    expect(
      notificationRoute(entry({ type: "upgrade.run", run: "run-key" }), session),
    ).toMatchObject({
      to: "/activity",
      state: { openUpgradeRun: "run-key" },
    })
  })

  it("opens the migration dialog, in place, for an upgrade that needs the user", () => {
    expect(notificationRoute(entry({ type: "migration.run" }), session)).toEqual({
      migration: "run",
    })
  })

  it("opens the claim screen for a registration in flight", () => {
    expect(
      notificationRoute(entry({ type: "registration.pending", tag: "alice" }), session),
    ).toEqual({
      to: "/claim/alice",
    })
    expect(
      notificationRoute(
        entry({ type: "registration.pending" } as NotificationEntry["target"]),
        session,
      ),
    ).toBeNull()
  })

  it("opens Home and the link's review for a registration a payment link funds", () => {
    ticket.value = true
    try {
      expect(
        notificationRoute(entry({ type: "registration.pending", tag: "alice" }), session),
      ).toEqual({
        to: "/",
        activate: true,
      })
    } finally {
      ticket.value = false
    }
  })
})
