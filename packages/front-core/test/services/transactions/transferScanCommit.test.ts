import { describe, expect, it } from "vitest"
import { TransferEventScanner } from "../../../src/core/services/transactions/TransferEventScanner"
import type { ScannedTransferEvent } from "@obsidion/sdk"
import { seededActivity } from "../../utils/activityFixture"
import { diskKv } from "../../engine/diskKv"

const ME = "0x" + "aa".repeat(32)
const ALICE = "0x" + "bb".repeat(32)
const CURSOR = `@obsidion/transfer-scan/cursor/v1/net/${ME}`
const HASH = "0x" + "01".repeat(32)

describe("transfer scan: rows and cursor save together", () => {
  it("a failed save keeps neither the receive nor the cursor, and the next pass files both", async () => {
    const disk = diskKv()
    const { kv } = disk
    const activity = seededActivity([], { kv })
    const event: ScannedTransferEvent = {
      txHash: HASH,
      from: ALICE,
      to: ME,
      amount: "5",
      blockNumber: 10,
    }
    const scanner = new TransferEventScanner({
      source: {
        headBlock: async () => 100,
        listIncoming: async () => [event],
        blockTimestampMs: async (b) => b * 1000,
      },
      kv,
      transactionStore: activity,
      tags: { resolveL2: async () => null },
      contacts: { findByL2Address: async () => null },
      token: { address: "0xtok", symbol: "DAI", decimals: 6 },
    })
    const ctx = { accountAddress: ME, accountTag: "me", networkId: "net" }

    disk.fail(true)
    await expect(scanner.pass(ctx, { full: true })).rejects.toThrow("disk")
    expect(activity.hasTxHash(HASH)).toBe(false)
    expect(kv.getItem(CURSOR)).toBeNull()
    expect(kv.keys().filter((k) => k.startsWith("acct/activity/"))).toEqual([])

    disk.fail(false)
    await scanner.pass(ctx, { full: true })
    expect(activity.hasTxHash(HASH)).toBe(true)
    expect(kv.getItem(CURSOR)).toBe("100")
    expect(kv.getItem(`acct/activity/${HASH}`)).not.toBeNull()
  })
})
