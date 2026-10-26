/**
 * A notification's target becomes `/activity` router state, which the feed resolves back to a row.
 * Bridge targets carry the producer's lowercased SIPA address; records keep it checksummed.
 */
import { describe, expect, it, vi } from "vitest"
import type { ActivityItem, AppNotificationEntry } from "@obsidion/front-core"

vi.mock("@obsidion/web-ds", () => ({
  ActivityListRow: () => null,
  GradientInitialAvatar: () => null,
  Icon: () => null,
  avatarColors: () => ["#000", "#fff"],
}))

/** Whether the open registration is one a payment link funds. */
const ticket = vi.hoisted(() => ({ value: false }))
vi.mock("../src/features/paylink/ticketContinuation", () => ({
  pendingTicketRegistration: () => ticket.value,
  ticketSignupCommitted: () => false,
}))

const { notificationRoute } = await import("../src/ui/NotificationsPanel")
const { bridgeDetailTarget, detailNoticeFor, findBridgeItem, savingsMoveExitOffer } = await import(
  "../src/ui/screens/useActivityEntries"
)

const SIPA = "0xAbCdEf0000000000000000000000000000000001"

function entry(target: AppNotificationEntry["target"]): AppNotificationEntry {
  return {
    id: "x",
    producer: "bridge",
    domain: "bridge",
    sourceId: "x",
    title: "",
    description: "",
    timestampMs: 0,
    systemIcon: "",
    severity: "info",
    target,
  } as AppNotificationEntry
}

const items = [
  { kind: "bridge.withdrawal", record: { localId: "w1", l2TxHash: "0xBurn" } },
  { kind: "bridge.sipaDeposit", record: { sipaAddress: SIPA, claimTxHash: "0xClaim" } },
  { kind: "transfer", record: { txHash: "0xt" } },
] as unknown as ActivityItem[]

describe("notification target -> activity detail", () => {
  it("routes bridge targets by kind and tx targets by hash", () => {
    expect(
      notificationRoute(
        entry({ type: "bridge.txDetail", bridgeKind: "withdrawal", sourceId: "w1" }),
      ),
    ).toMatchObject({ to: "/activity", state: { openWithdrawalId: "w1" } })
    expect(
      notificationRoute(
        entry({ type: "bridge.txDetail", bridgeKind: "deposit", sourceId: SIPA.toLowerCase() }),
      ),
    ).toMatchObject({ to: "/activity", state: { openDepositAddress: SIPA.toLowerCase() } })
    expect(notificationRoute(entry({ type: "transfer.txDetail", txHash: "0xt" }))).toMatchObject({
      to: "/activity",
      state: { openTxHash: "0xt" },
    })
  })

  it("outdates a reorg failure notice once its row confirms; a confirmation notice never", () => {
    const reorg = { type: "reorg.txDetail", txHash: "0xt" }
    expect(notificationRoute({ ...entry(reorg), severity: "error" })?.state).toMatchObject({
      openTxHash: "0xt",
      noticeStaleOn: "success",
    })
    expect(notificationRoute({ ...entry(reorg), severity: "success" })?.state).not.toHaveProperty(
      "noticeStaleOn",
    )
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
    expect(notificationRoute(entry({ type: "contact.added", contactId: "bob" }))).toEqual({
      to: "/contacts/bob",
    })
    expect(notificationRoute(entry({ type: "contact.added" }))).toBeNull()
  })

  it("opens the migration dialog, in place, for funds left on an old version", () => {
    expect(notificationRoute(entry({ type: "migration.residuals" }))).toEqual({
      migration: "residuals",
    })
  })

  it("opens an upgrade's run in activity", () => {
    expect(notificationRoute(entry({ type: "upgrade.run", run: "run-key" }))).toMatchObject({
      to: "/activity",
      state: { openUpgradeRun: "run-key" },
    })
  })

  it("opens the migration dialog, in place, for an upgrade that needs the user", () => {
    expect(notificationRoute(entry({ type: "migration.run" }))).toEqual({ migration: "run" })
  })

  it("opens the claim screen for a registration in flight", () => {
    expect(notificationRoute(entry({ type: "registration.pending", tag: "alice" }))).toEqual({
      to: "/claim/alice",
    })
    expect(notificationRoute(entry({ type: "registration.pending" }))).toBeNull()
  })

  it("opens Home and the link's review for a registration a payment link funds", () => {
    ticket.value = true
    try {
      expect(notificationRoute(entry({ type: "registration.pending", tag: "alice" }))).toEqual({
        to: "/",
        activate: true,
      })
    } finally {
      ticket.value = false
    }
  })

  it("finds the bridge row, matching SIPA addresses case-insensitively", () => {
    expect(findBridgeItem(items, { openWithdrawalId: "w1" })?.kind).toBe("bridge.withdrawal")
    expect(findBridgeItem(items, { openDepositAddress: SIPA.toLowerCase() })?.kind).toBe(
      "bridge.sipaDeposit",
    )
    expect(findBridgeItem(items, { openWithdrawalId: "nope" })).toBeUndefined()
  })

  it("opens a Savings move's burn in the Savings detail its row opens, and a fresh leg as its group", () => {
    const withdrawal = (record: object) => ({ kind: "bridge.withdrawal", record }) as never
    expect(
      bridgeDetailTarget(withdrawal({ localId: "m1", skyMove: { direction: "out" } })),
    ).toEqual({
      savings: "m1",
    })
    expect(bridgeDetailTarget(withdrawal({ localId: "w2", groupId: "g1" }))).toEqual({
      withdrawal: "g1",
    })
    expect(bridgeDetailTarget(withdrawal({ localId: "w3" }))).toEqual({ withdrawal: "w3" })
    expect(bridgeDetailTarget(items[1] as never)).toEqual({ deposit: SIPA })
  })

  it("resolves a reorg notice's tx hash to the bridge row it was taken from", () => {
    expect(findBridgeItem(items, { openTxHash: "0xburn" })?.kind).toBe("bridge.withdrawal")
    expect(findBridgeItem(items, { openTxHash: "0xclaim" })?.kind).toBe("bridge.sipaDeposit")
    expect(findBridgeItem(items, { openTxHash: "0xt" })).toBeUndefined()
    expect(findBridgeItem(items, {})).toBeUndefined()
  })
})

describe("savingsMoveExitOffer", () => {
  it("offers a stalled move's finalize in either direction, then the escrow's run once it is funded", () => {
    const later = Date.now() + 365 * 24 * 3_600_000
    const sky = {
      direction: "out",
      factory: "0x00000000000000000000000000000000000000fa",
      recipientCommitment: `0x${"02".repeat(32)}`,
      recoveryCommitment: `0x${"03".repeat(32)}`,
      relayerTip: "1",
      nonce: `0x${"01".repeat(32)}`,
    }
    const burn = (extra: object) =>
      ({
        localId: "w1",
        l2TxHash: "0xburn",
        startTime: 0,
        phaseEnteredAt: 0,
        skyMove: sky,
        ...extra,
      }) as never
    const move = (direction: "in" | "out", extra: object = {}) =>
      ({
        direction,
        withdrawalLocalId: "w1",
        escrow: "0x00000000000000000000000000000000000000ee",
        nonce: sky.nonce,
        ...extra,
      }) as never
    for (const direction of ["in", "out"] as const)
      expect(savingsMoveExitOffer(move(direction), burn({ phase: "finalizing_l1" }), later)).toBe(
        "finalize",
      )
    expect(savingsMoveExitOffer(move("out"), burn({ phase: "done", endTime: 0 }), later)).toBe(
      "run",
    )
    expect(
      savingsMoveExitOffer(
        move("out", { deposit: { inboxIndex: "1", amount: "1", claimed: false } }),
        burn({ phase: "done", endTime: 0 }),
        later,
      ),
    ).toBeNull()
    expect(savingsMoveExitOffer(move("in"), burn({ phase: "finalizing_l1" }), 1)).toBeNull()
  })
})
