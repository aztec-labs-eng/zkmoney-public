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

const { notificationRoute } = await import("../src/ui/NotificationsPanel")
const { findBridgeItem } = await import("../src/ui/screens/useActivityEntries")

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

  it("opens a mutual-add notice on the contact page", () => {
    expect(notificationRoute(entry({ type: "contact.added", contactId: "bob" }))).toEqual({
      to: "/contacts/bob",
    })
    expect(notificationRoute(entry({ type: "contact.added" }))).toBeNull()
  })

  it("opens the Activity screen for funds left on an old version", () => {
    expect(notificationRoute(entry({ type: "migration.residuals" }))).toEqual({ to: "/activity" })
  })

  it("finds the bridge row, matching SIPA addresses case-insensitively", () => {
    expect(findBridgeItem(items, { openWithdrawalId: "w1" })?.kind).toBe("bridge.withdrawal")
    expect(findBridgeItem(items, { openDepositAddress: SIPA.toLowerCase() })?.kind).toBe(
      "bridge.sipaDeposit",
    )
    expect(findBridgeItem(items, { openWithdrawalId: "nope" })).toBeUndefined()
  })

  it("resolves a reorg notice's tx hash to the bridge row it was taken from", () => {
    expect(findBridgeItem(items, { openTxHash: "0xburn" })?.kind).toBe("bridge.withdrawal")
    expect(findBridgeItem(items, { openTxHash: "0xclaim" })?.kind).toBe("bridge.sipaDeposit")
    expect(findBridgeItem(items, { openTxHash: "0xt" })).toBeUndefined()
    expect(findBridgeItem(items, {})).toBeUndefined()
  })
})
