import { describe, expect, it, vi } from "vitest"
import {
  TRANSFER_SCAN_REORG_MARGIN,
  TransferEventScanner,
} from "../../../src/core/services/transactions/TransferEventScanner"
import type { ScannedTransferEvent } from "@obsidion/sdk"
import { seededActivity } from "../../utils/transferFixture"

const ME = "0x" + "aa".repeat(32)
const ALICE = "0x" + "bb".repeat(32)
const CURSOR = `acct/transferScanCursor/net/${ME}`
const HASH = "0x" + "01".repeat(32)

describe("transfer scan: rows and cursor save together", () => {
  it("a failed save keeps neither the receive nor the cursor, and the next pass files both", async () => {
    const transfers = seededActivity()
    const { db, backend } = transfers
    await transfers.ready
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
      db,
      transactionStore: transfers,
      tags: { resolveL2: async () => null },
      contacts: { findByL2Address: async () => null },
      token: { address: "0xtok", symbol: "DAI", decimals: 6 },
    })
    const ctx = { accountAddress: ME, accountTag: "me", networkId: "net" }

    backend.failing.commits = true
    await expect(scanner.pass(ctx, { full: true })).rejects.toMatchObject({ code: "unknown" })
    expect(await transfers.hasTxHash(HASH)).toBe(false)
    expect(backend.entries.get(CURSOR)).toBeUndefined()
    expect([...backend.entries.keys()].filter((k) => k.startsWith("acct/transfers/"))).toEqual([])

    backend.failing.commits = false
    await scanner.pass(ctx, { full: true })
    expect(await transfers.hasTxHash(HASH)).toBe(true)
    expect(backend.entries.get(CURSOR)).toBe("100")
    expect(backend.entries.get(`acct/transfers/${HASH}`)).toBeDefined()
  })

  it("resumes from an older build's cursor and saves its own key with the rows, never the older", async () => {
    const OLDER = `@obsidion/transfer-scan/cursor/v1/net/${ME}`
    const transfers = seededActivity()
    const { db, backend } = transfers
    await transfers.ready
    backend.entries.set(OLDER, "1000")
    const event = { txHash: HASH, from: ALICE, to: ME, amount: "5", blockNumber: 1_050 }
    const listIncoming = vi.fn(async () => [event])
    const scanner = new TransferEventScanner({
      source: { headBlock: async () => 1_100, listIncoming, blockTimestampMs: async (b) => b },
      db,
      transactionStore: transfers,
      tags: { resolveL2: async () => null },
      contacts: { findByL2Address: async () => null },
      token: { address: "0xtok", symbol: "DAI", decimals: 6 },
    })
    await scanner.pass({ accountAddress: ME, accountTag: "me", networkId: "net" })
    expect(listIncoming).toHaveBeenCalledWith(1_000 - TRANSFER_SCAN_REORG_MARGIN, 1_101)
    expect(await transfers.hasTxHash(HASH)).toBe(true)
    expect(backend.entries.get(CURSOR)).toBe("1100")
    expect(backend.entries.get(OLDER)).toBe("1000")
  })
})
