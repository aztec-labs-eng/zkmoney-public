/**
 * ActivityFeed over the withdrawal arm, merged with SIPA deposits: the two
 * sources interleave newest-first in one feed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Address } from "viem"
import { InMemoryStorageAdapter } from "../../__test-helpers__/InMemoryStorageAdapter"
import { resetSingleton } from "../../__test-helpers__/resetSingleton"
import {
  SIPADepositStore,
  type SIPADepositRecord,
} from "../../../src/core/services/deposits/SIPADepositStore"
import { WithdrawalStorage } from "../../../src/core/services/bridge/WithdrawalStorage"
import {
  ActivityFeed,
  isBridgeActivityItem,
} from "../../../src/core/services/bridge/BridgeActivityFeed"
import { STUCK_SWEEP_MS } from "../../../src/core/services/deposits/sipaStuck"
import type { WithdrawalRecord } from "../../../src/core/services/bridge/types"

const SIPA_RECIPIENT = "0x2589c51355cabd0722def6dabd818a309c4a8fc2d4cbc3ce2bf2eaaf59318456"
const L1_RECIPIENT = "0x1234567890abcdef1234567890abcdef12345678" as Address

function resetAll() {
  resetSingleton(ActivityFeed as unknown as { instance: ActivityFeed | null })
  resetSingleton(SIPADepositStore as unknown as { instance: SIPADepositStore | null })
  resetSingleton(WithdrawalStorage as unknown as { instance: WithdrawalStorage | null })
}

function sipaFallback(startTime: number): Omit<SIPADepositRecord, "sipaAddress" | "phase"> {
  return {
    recipientL2Address: SIPA_RECIPIENT,
    messageSecret: "0x" + "11".repeat(32),
    recipientHash: "0x" + "22".repeat(32),
    recoveryAddress: "0xfd9df8ea9d7350063da52e60e7e1b6d78449786a",
    l1ChainId: 11155111,
    amount: "12.5",
    tokenSymbol: "DAI",
    startTime,
  }
}

function withdrawalRecord(
  overrides: Partial<WithdrawalRecord> & { localId: string },
): WithdrawalRecord {
  return {
    recipient: L1_RECIPIENT,
    recipientProvenance: "saved-recipient",
    amount: "5.0",
    tokenSymbol: "DAI",
    phase: "l2_mined",
    startTime: 100,
    ...overrides,
  }
}

async function stores(): Promise<{ sipa: SIPADepositStore; withdrawals: WithdrawalStorage }> {
  resetAll()
  const sipa = SIPADepositStore.get(new InMemoryStorageAdapter())
  const withdrawals = WithdrawalStorage.get(new InMemoryStorageAdapter())
  await sipa.load()
  await withdrawals.load()
  return { sipa, withdrawals }
}

describe("ActivityFeed (withdrawal + SIPA union)", () => {
  beforeEach(resetAll)
  afterEach(() => vi.useRealTimers())

  it("interleaves withdrawal and SIPA rows newest-first and notifies on either store changing", async () => {
    const { sipa, withdrawals } = await stores()
    const feed = ActivityFeed.get(sipa, withdrawals)

    const snapshots: unknown[][] = []
    feed.onChanged((items) => snapshots.push(items))

    await sipa.upsert(
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address,
      { phase: "claimed" },
      sipaFallback(300),
    )
    await withdrawals.create(withdrawalRecord({ localId: "w1", startTime: 400 }))

    const items = feed.list()
    expect(items.map((i) => i.kind)).toEqual(["bridge.withdrawal", "bridge.sipaDeposit"])
    expect(items.every(isBridgeActivityItem)).toBe(true)
    expect(snapshots.length).toBeGreaterThanOrEqual(2)
  })

  it("hides a SIPA deposit this wallet funded with its own withdrawal", async () => {
    const { sipa, withdrawals } = await stores()
    const feed = ActivityFeed.get(sipa, withdrawals)
    const registrationSipa = "0x0FC0000000000000000000000000000000000414" as Address

    await sipa.upsert(registrationSipa, { phase: "pendingClaim" }, sipaFallback(300))
    await sipa.upsert(
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address,
      { phase: "claimed" },
      sipaFallback(200),
    )
    await withdrawals.create(
      withdrawalRecord({
        localId: "burn",
        recipient: registrationSipa.toLowerCase() as Address,
        startTime: 400,
      }),
    )

    const items = feed.list()
    expect(items.map((i) => i.kind)).toEqual(["bridge.withdrawal", "bridge.sipaDeposit"])
    expect(
      items.some(
        (i) => i.kind === "bridge.sipaDeposit" && i.record.sipaAddress === registrationSipa,
      ),
    ).toBe(false)
  })

  it("keeps a migration's arrival beside its exit", async () => {
    const { sipa, withdrawals } = await stores()
    const feed = ActivityFeed.get(sipa, withdrawals)
    const arrival = "0x0FC0000000000000000000000000000000000415" as Address

    await sipa.upsert(arrival, { phase: "resolved" }, sipaFallback(300))
    await withdrawals.create(
      withdrawalRecord({
        localId: "exit",
        intent: "migration",
        recipient: arrival.toLowerCase() as Address,
        startTime: 400,
      }),
    )

    expect(feed.list().map((i) => i.kind)).toEqual(["bridge.withdrawal", "bridge.sipaDeposit"])
  })

  it("surfaces a self-funded SIPA deposit that needs the user: failed, recoverable, or a failed burn", async () => {
    const registrationSipa = "0x0FC0000000000000000000000000000000000414" as Address
    for (const phase of ["failed", "recoverable"] as const) {
      const { sipa, withdrawals } = await stores()
      const feed = ActivityFeed.get(sipa, withdrawals)
      await sipa.upsert(registrationSipa, { phase }, sipaFallback(300))
      await withdrawals.create(
        withdrawalRecord({ localId: "burn", recipient: registrationSipa, startTime: 400 }),
      )
      expect(feed.list().map((i) => i.kind)).toEqual(["bridge.withdrawal", "bridge.sipaDeposit"])
    }
    const { sipa, withdrawals } = await stores()
    const feed = ActivityFeed.get(sipa, withdrawals)
    await sipa.upsert(registrationSipa, { phase: "pendingClaim" }, sipaFallback(300))
    await withdrawals.create(
      withdrawalRecord({
        localId: "burn",
        recipient: registrationSipa,
        startTime: 400,
        phase: "failed",
      }),
    )
    expect(feed.list().map((i) => i.kind)).toEqual(["bridge.withdrawal", "bridge.sipaDeposit"])
  })

  it("surfaces a self-funded deposit once its sweep has stalled, and wakes listeners when it does", async () => {
    vi.useFakeTimers()
    const registrationSipa = "0x0FC0000000000000000000000000000000000414" as Address
    const { sipa, withdrawals } = await stores()
    const feed = ActivityFeed.get(sipa, withdrawals)
    const seen: string[][] = []
    feed.onChanged((items) => seen.push(items.map((i) => i.kind)))
    const startTime = Date.now() - STUCK_SWEEP_MS + 1_000
    await sipa.upsert(registrationSipa, { phase: "sweeping" }, sipaFallback(startTime))
    await withdrawals.create(
      withdrawalRecord({
        localId: "burn",
        recipient: registrationSipa,
        phase: "done",
        startTime: startTime + 1,
      }),
    )
    seen.length = 0
    // Still progressing: one story, the withdrawal row.
    expect(feed.list().map((i) => i.kind)).toEqual(["bridge.withdrawal"])

    await vi.advanceTimersByTimeAsync(1_000)
    expect(seen).toEqual([["bridge.withdrawal", "bridge.sipaDeposit"]])
    expect(feed.list().map((i) => i.kind)).toEqual(["bridge.withdrawal", "bridge.sipaDeposit"])

    // A confirmed self-sweep is waiting on the next scan, not stuck: hidden again, no clock.
    await sipa.upsert(registrationSipa, { phase: "sweeping", sweepTxHash: `0x${"ab".repeat(32)}` })
    expect(feed.list().map((i) => i.kind)).toEqual(["bridge.withdrawal"])
    seen.length = 0
    await vi.advanceTimersByTimeAsync(STUCK_SWEEP_MS)
    expect(seen).toEqual([])
  })

  it("keeps working with the SIPA store alone (withdrawal store optional)", async () => {
    resetAll()
    const sipa = SIPADepositStore.get(new InMemoryStorageAdapter())
    await sipa.load()
    const feed = ActivityFeed.get(sipa)
    await sipa.upsert(
      "0xcccccccccccccccccccccccccccccccccccccccc" as Address,
      { phase: "broadcast" },
      sipaFallback(200),
    )
    expect(feed.list().map((i) => i.kind)).toEqual(["bridge.sipaDeposit"])
  })
})
