/**
 * ActivityFeed over the SIPA-only union (the legacy deposit and withdrawal
 * stores were removed with the ens-gateway/bridge decommission).
 */

import { beforeEach, describe, expect, it } from "vitest"
import type { Address } from "viem"
import { InMemoryStorageAdapter } from "../../__test-helpers__/InMemoryStorageAdapter"
import { resetSingleton } from "../../__test-helpers__/resetSingleton"
import {
  SIPADepositStore,
  type SIPADepositRecord,
} from "../../../src/core/services/deposits/SIPADepositStore"
import { ActivityFeed } from "../../../src/core/services/bridge/BridgeActivityFeed"

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
})
