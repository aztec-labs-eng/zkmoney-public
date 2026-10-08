/**
 * ActivityFeed over the SIPA-only union (the legacy deposit and withdrawal
 * stores were removed with the ens-gateway/bridge decommission).
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Address } from "viem"
import { InMemoryStorageAdapter } from "../../__test-helpers__/InMemoryStorageAdapter"
import { resetSingleton } from "../../__test-helpers__/resetSingleton"
import {
  SIPADepositStore,
  type SIPADepositRecord,
} from "../../../src/core/services/deposits/SIPADepositStore"
import {
  ActivityFeed,
  type SipaProcessingSource,
} from "../../../src/core/services/bridge/BridgeActivityFeed"
import type { SipaProcessingState } from "../../../src/core/services/deposits/sipaProcessing"
import { STUCK_SWEEP_MS } from "../../../src/core/services/deposits/sipaStuck"

const RECIPIENT = "0x2589c51355cabd0722def6dabd818a309c4a8fc2d4cbc3ce2bf2eaaf59318456"

function resetAll() {
  resetSingleton(ActivityFeed as unknown as { instance: ActivityFeed | null })
  resetSingleton(SIPADepositStore as unknown as { instance: SIPADepositStore | null })
}

function makeStore(): SIPADepositStore {
  resetAll()
  return SIPADepositStore.get(new InMemoryStorageAdapter())
}

function sipaFallback(startTime: number): Omit<SIPADepositRecord, "sipaAddress" | "phase"> {
  return {
    recipientL2Address: RECIPIENT,
    messageSecret: "0x" + "11".repeat(32),
    recipientHash: "0x" + "22".repeat(32),
    recoveryAddress: "0xfd9df8ea9d7350063da52e60e7e1b6d78449786a",
    l1ChainId: 11155111,
    amount: "12.5",
    tokenSymbol: "DAI",
    startTime,
  }
}

describe("ActivityFeed (SIPA-only union)", () => {
  beforeEach(resetAll)

  it("lists newest-first and notifies on store changes", async () => {
    const sipaDeposits = makeStore()
    const feed = ActivityFeed.get(sipaDeposits)

    const snapshots: unknown[][] = []
    feed.onChanged((items) => snapshots.push(items))

    await sipaDeposits.upsert(
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address,
      { phase: "claimed" },
      sipaFallback(300),
    )
    await sipaDeposits.upsert(
      "0xcccccccccccccccccccccccccccccccccccccccc" as Address,
      { phase: "broadcast" },
      sipaFallback(400),
    )

    const items = feed.list()
    expect(items.map((item) => item.kind)).toEqual(["bridge.sipaDeposit", "bridge.sipaDeposit"])
    expect(items.map((item) => ("record" in item ? item.record.startTime : 0))).toEqual([400, 300])
    expect(snapshots.length).toBeGreaterThanOrEqual(2)
  })

  it("requires the SIPA store on first construction", () => {
    resetAll()
    expect(() => ActivityFeed.get()).toThrow(/requires the SIPADepositStore/)
  })

  describe("with a processing source", () => {
    const WAITING = "0xdddddddddddddddddddddddddddddddddddddddd" as Address
    const DONE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address

    function source(initial: Record<string, SipaProcessingState>) {
      const states = new Map(Object.entries(initial))
      const listeners = new Set<() => void>()
      const src: SipaProcessingSource = {
        stateFor: (sipa) => states.get(sipa.toLowerCase()),
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
      return {
        src,
        listeners,
        set(sipa: string, state: SipaProcessingState) {
          states.set(sipa.toLowerCase(), state)
          for (const listener of listeners) listener()
        },
      }
    }

    it("annotates the deposits it explains and re-emits when a reason changes", async () => {
      const sipaDeposits = makeStore()
      await sipaDeposits.upsert(WAITING, { phase: "sweeping" }, sipaFallback(400))
      await sipaDeposits.upsert(DONE, { phase: "claimed" }, sipaFallback(300))
      const feed = ActivityFeed.get(sipaDeposits)
      const snapshots: unknown[][] = []
      feed.onChanged((items) => snapshots.push(items))

      const waiting: SipaProcessingState = { reason: { kind: "checking" } }
      const s = source({ [WAITING]: waiting })
      feed.setProcessingSource(s.src)
      expect(s.listeners.size).toBe(1)
      expect(feed.list()).toEqual([
        { kind: "bridge.sipaDeposit", record: sipaDeposits.get(WAITING), processing: waiting },
        { kind: "bridge.sipaDeposit", record: sipaDeposits.get(DONE) },
      ])

      const count = snapshots.length
      const processing: SipaProcessingState = {
        reason: { kind: "processing", availableAtomic: 5n, decimals: 18, observedAt: 1 },
      }
      s.set(WAITING, processing)
      expect(snapshots.length).toBe(count + 1)
      expect(snapshots.at(-1)?.[0]).toMatchObject({ processing })
      // The source explains; it never changes the record.
      expect(sipaDeposits.get(WAITING)?.phase).toBe("sweeping")
    })

    it("re-emits when a shown deposit reaches the stuck clock", async () => {
      vi.useFakeTimers()
      try {
        vi.setSystemTime(10_000_000)
        const sipaDeposits = makeStore()
        await sipaDeposits.upsert(WAITING, { phase: "sweeping" }, sipaFallback(Date.now() - 60_000))
        const feed = ActivityFeed.get(sipaDeposits)
        const snapshots: unknown[][] = []
        feed.onChanged((items) => snapshots.push(items))
        feed.setProcessingSource(source({ [WAITING]: { reason: { kind: "checking" } } }).src)
        const count = snapshots.length
        await vi.advanceTimersByTimeAsync(STUCK_SWEEP_MS - 60_000 - 1)
        expect(snapshots.length).toBe(count)
        await vi.advanceTimersByTimeAsync(1)
        expect(snapshots.length).toBe(count + 1)
      } finally {
        vi.useRealTimers()
      }
    })

    it("detaches a replaced source", async () => {
      const sipaDeposits = makeStore()
      await sipaDeposits.upsert(WAITING, { phase: "sweeping" }, sipaFallback(400))
      const feed = ActivityFeed.get(sipaDeposits)
      feed.onChanged(() => {})
      const s = source({ [WAITING]: { reason: { kind: "checking" } } })
      feed.setProcessingSource(s.src)
      feed.setProcessingSource(null)
      expect(s.listeners.size).toBe(0)
      expect(feed.list()).toEqual([
        { kind: "bridge.sipaDeposit", record: sipaDeposits.get(WAITING) },
      ])
    })
  })
})
