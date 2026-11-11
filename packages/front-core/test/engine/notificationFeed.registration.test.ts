// @vitest-environment node
/** A received registration's live row names why its deposit waits only when the wait is shown. */
import { describe, expect, it } from "vitest"
import type { SipaProcessingState } from "../../src/core/services/deposits/sipaProcessing"
import { deriveNotifications, type NotificationSources } from "../../src/engine/notificationFeed"
import type { PendingRegistrationRecord } from "../../src/engine/registrationRecord"
import type { SipaDeposit } from "../../src/engine/sipaDeposits"

const NOW = 1_800_000_000_000
const SIPA = `0x${"d1".repeat(20)}`

const record = {
  account: "0xACC",
  nameHash: "0xNH",
  l2Address: "0xL2",
  sipaAddress: SIPA,
  tag: "ada",
  phase: "awaiting_deposit",
  startTime: NOW - 60_000,
  fundedAt: NOW - 30_000,
} as PendingRegistrationRecord

const deposit = {
  sipaAddress: SIPA,
  phase: "funded",
  intent: "registration",
  amount: "20",
  startTime: NOW - 30_000,
} as SipaDeposit

function liveAbout(processing?: SipaProcessingState, deposits: SipaDeposit[] = [deposit]) {
  const sources: NotificationSources = {
    rows: [],
    links: [],
    oldVersionWithdrawals: [],
    bridgeIns: { records: [], hydrated: true },
    deposits: { records: deposits, hydrated: true },
    withdrawals: { records: [], hydrated: true },
    upgrades: { items: [], recipients: new Set(), loaded: true },
    processing: new Map(processing ? [[SIPA, processing]] : []),
    registrations: [record],
    operations: { ended: [], running: [] },
    loaded: true,
    account: "0xl2",
  }
  const entries = deriveNotifications(sources, new Map(), NOW)
  expect(entries.map((e) => e.id)).toEqual(["registration:0xacc:0xnh:live"])
  return entries[0]!.about
}

describe("a received registration's live row", () => {
  it("names a confirmed blocker on its deposit", () => {
    const capped = { reason: { kind: "operation-cap", observedAt: NOW } } as SipaProcessingState
    expect(liveAbout(capped)).toEqual({
      kind: "registrationLive",
      tag: "ada",
      stage: "received",
      reason: "operation-cap",
    })
  })

  it("names no reason while a fresh deposit is still checked, or with no deposit seen", () => {
    const checking = { reason: { kind: "checking" } } as SipaProcessingState
    expect(liveAbout(checking)).not.toHaveProperty("reason")
    expect(liveAbout(checking, [])).not.toHaveProperty("reason")
  })
})
