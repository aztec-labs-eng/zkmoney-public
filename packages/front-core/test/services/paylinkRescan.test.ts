import { afterEach, describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec/aztec.js/fields"
import type { ScannedTransferEvent } from "@obsidion/sdk"
import { rebuildPaylinks } from "../../src/core/services/paylink/paylinkRescan"

import { TransactionStorage } from "../../src/core/storages/TransactionStorage"
import { setActiveNetworkId } from "../../src/core/activeNetworkId"
import { TRANSACTIONS_STORAGE_KEY } from "../../src/core/storages/constants"
import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"

const ME = "0x00aa"
const secret = Fr.random()
const fallbackSecret = Fr.random()
const MASTER_SECRET = Fr.random()
const lane = { flavor: "direct" as const, day: 20_000, secret, fallbackKeyHash: Fr.random() }
const TOKEN = { address: "0xtoken", symbol: "DAI", decimals: 18 }

function event(over: Partial<ScannedTransferEvent>): ScannedTransferEvent {
  return {
    txHash: "0x1",
    from: ME,
    to: "0xescrow",
    amount: "2500000000000000000",
    blockNumber: 10,
    paylinkCreated: lane,
    memo: "lunch",
    ...over,
  }
}

const params = (txHash: string) => ({
  secret,
  fallbackSecret,
  classId: Fr.ZERO,
  chainId: 31337,
  rollupVersion: 1,
  txHash,
  paylinkType: "paylinkDirect" as const,
  amount: 2_500_000_000_000_000_000n,
  email: undefined,
})

function makeDeps(events: ScannedTransferEvent[], over: Record<string, unknown> = {}) {
  const store = {
    hasTxHash: vi.fn(async (h: string) => h === "0xknown"),
    findByTxHash: vi.fn(async () => null),
    addRecoveredPaylinkTransaction: vi.fn(async (row: { txHash: string }) => ({
      tx: row as never,
      inserted: true,
    })),
  }
  const paylinkService = {
    recoverPaylinkFromTransfer: vi.fn(async (e: ScannedTransferEvent) =>
      e.to === "0xescrow" ? params(e.txHash) : null,
    ),
    isPaylinkClaimed: vi.fn(async () => false),
    sync_note: vi.fn(async () => ({
      claimableFrom: 100,
      claimableUntil: 200,
      refundableUntil: 200,
    })),
    ...over,
  }
  const linkFor = vi.fn(async (p: { txHash: string }) => `https://link/${p.txHash}`)
  return {
    deps: {
      source: {
        headBlock: vi.fn(async () => 40),
        listIncoming: vi.fn(async () => events),
        blockTimestampMs: vi.fn(async (b: number) => (b === 10 ? 1_000 : undefined)),
      },
      accountAddress: ME.toUpperCase(),
      masterSecret: MASTER_SECRET,
      networkId: "network-A",
      paylinkService: paylinkService as never,
      linkFor,
      store: store as never,
      token: TOKEN,
      now: () => 9_999,
    },
    store,
    paylinkService,
    linkFor,
  }
}

describe("rebuildPaylinks", () => {
  it("writes one PAY row per unknown, unspent funding transfer of the account, oldest first", async () => {
    const { deps, store, paylinkService } = makeDeps([
      event({ txHash: "0x2", blockNumber: 20 }),
      event({ txHash: "0x1", blockNumber: 10 }),
      event({ txHash: "0xknown", blockNumber: 30 }),
      event({ txHash: "0xin", from: "0xother", to: ME }), // a receive
      event({ txHash: "0xplain", paylinkCreated: undefined }), // a plain send
      event({ txHash: "0xforged", to: "0xelsewhere" }), // lane does not derive the payee
    ])

    const rows = await rebuildPaylinks(deps)

    expect(deps.source.listIncoming).toHaveBeenCalledWith(1, 41)
    expect(rows.map((r) => r.txHash)).toEqual(["0x1", "0x2"])
    expect(paylinkService.recoverPaylinkFromTransfer).toHaveBeenCalledTimes(3)
    expect(paylinkService.recoverPaylinkFromTransfer).toHaveBeenCalledWith(expect.anything(), MASTER_SECRET)
    expect(store.addRecoveredPaylinkTransaction.mock.calls[0]![0]).toMatchObject({
      txHash: "0x1",
      flavor: "direct",
      blockNumber: 10,
      timestamp: 1_000,
      payToEmailSecret: secret.toString(),
      fallbackSecret: fallbackSecret.toString(),
      obsidionAccountAddress: ME.toUpperCase(),
      tokenAddress: "0xtoken",
      paylink: "https://link/0x1",
      fromClaimable: 100,
      untilClaimable: 200,
      refundableUntil: 200,
      memo: "lunch",
      networkId: "network-A",
      token: { symbol: "DAI", amount: 2.5, price: 1 },
    })
    expect(store.addRecoveredPaylinkTransaction.mock.calls[1]![0]).toMatchObject({
      txHash: "0x2",
      timestamp: 9_999,
    })
  })

  it("skips a spent escrow and defers a link whose note cannot be read", async () => {
    const { deps, store } = makeDeps([event({ txHash: "0x1" }), event({ txHash: "0x2" })], {
      isPaylinkClaimed: vi.fn(async (_p: unknown) => false),
      sync_note: vi
        .fn()
        .mockRejectedValueOnce(new Error("not synced"))
        .mockResolvedValue({ claimableFrom: 1, claimableUntil: 2, refundableUntil: 2 }),
    })
    ;(deps.paylinkService as { isPaylinkClaimed: ReturnType<typeof vi.fn> }).isPaylinkClaimed
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    const rows = await rebuildPaylinks(deps)
    expect(rows).toEqual([])
    expect(store.addRecoveredPaylinkTransaction).not.toHaveBeenCalled()
  })
})


describe("paylink rescan cursor", () => {
  const KEY = `@obsidion/paylink-rescan/cursor/v1/network-A/${ME}`

  it("resumes a reorg margin behind the saved cursor and saves PXE's synced block", async () => {
    const storage = new InMemoryStorageAdapter()
    const { deps } = makeDeps([])
    const source = { ...deps.source, anchorBlock: vi.fn(async () => 38) }
    await rebuildPaylinks({ ...deps, source, storage })
    expect(source.listIncoming).toHaveBeenLastCalledWith(1, 41)
    expect(await storage.getItem(KEY)).toBe("38")

    await storage.setItem(KEY, "100")
    await rebuildPaylinks({ ...deps, source, storage })
    expect(source.listIncoming).toHaveBeenLastCalledWith(1, 41)
    expect(await storage.getItem(KEY)).toBe("38")

    await storage.setItem(KEY, "30")
    source.headBlock.mockResolvedValue(200)
    source.anchorBlock.mockResolvedValue(200)
    await rebuildPaylinks({ ...deps, source, storage })
    expect(source.listIncoming).toHaveBeenLastCalledWith(1, 201)
    await rebuildPaylinks({ ...deps, source, storage })
    expect(source.listIncoming).toHaveBeenLastCalledWith(200 - 64, 201)
  })

  it("holds the cursor below a link whose note is not readable yet, and saves nothing when aborted", async () => {
    const storage = new InMemoryStorageAdapter()
    const { deps } = makeDeps([event({ txHash: "0x1", blockNumber: 10 }), event({ txHash: "0x2", blockNumber: 20 })], {
      sync_note: vi
        .fn()
        .mockResolvedValueOnce({ claimableFrom: 1, claimableUntil: 2, refundableUntil: 2 })
        .mockRejectedValueOnce(new Error("not synced")),
    })
    await rebuildPaylinks({ ...deps, storage })
    expect(await storage.getItem(KEY)).toBe("19")

    const controller = new AbortController()
    controller.abort()
    await storage.setItem(KEY, "5")
    await rebuildPaylinks({ ...deps, storage, signal: controller.signal })
    expect(await storage.getItem(KEY)).toBe("5")
  })
})

describe("paylink rescan ownership", () => {
  afterEach(() => {
    setActiveNetworkId(undefined)
    ;(TransactionStorage as unknown as { instance: TransactionStorage | null }).instance = null
  })

  it.each(["send-first", "paylink-first"])("keeps one complete PAY row when %s", async (order) => {
    const { deps } = makeDeps([event({})])
    const adapter = new InMemoryStorageAdapter()
    await adapter.setItem(TRANSACTIONS_STORAGE_KEY, "[]")
    const storage = TransactionStorage.get(adapter)
    const writeSend = () =>
      storage.addIncomingTokenTransaction({
        action: "send",
        txHash: "0x1",
        from: ME,
        senderL2Address: ME,
        to: "0xescrow",
        token: { ...TOKEN, name: "DAI", logo: "", amount: 2.5, price: 0 },
        timestamp: 1_000,
        networkId: "network-A",
      })
    if (order === "send-first") await writeSend()
    expect(await rebuildPaylinks({ ...deps, store: storage })).toHaveLength(1)
    // Also covers a scanner that passed its hasTxHash check before recovery wrote.
    if (order === "paylink-first") await writeSend()
    expect(await rebuildPaylinks({ ...deps, store: storage })).toEqual([])
    expect(await storage.getTransactions()).toEqual([
      expect.objectContaining({
        txHash: "0x1",
        flavor: "direct",
        paylink: "https://link/0x1",
        fallbackSecret: fallbackSecret.toString(),
      }),
    ])
  })

  it("persists the source network even if the active network changes during discovery", async () => {
    const { deps } = makeDeps([event({})], {
      sync_note: vi.fn(async () => {
        setActiveNetworkId("network-B")
        return { claimableFrom: 100, claimableUntil: 200, refundableUntil: 200 }
      }),
    })
    const adapter = new InMemoryStorageAdapter()
    await adapter.setItem(TRANSACTIONS_STORAGE_KEY, "[]")
    const storage = TransactionStorage.get(adapter)
    setActiveNetworkId("network-A")

    await rebuildPaylinks({ ...deps, store: storage })

    expect(await storage.getTransactions()).toEqual([
      expect.objectContaining({ txHash: "0x1", networkId: "network-A" }),
    ])
  })

  it.each(["events", "note", "link"])("does not write after disposal during %s discovery", async (stage) => {
    const controller = new AbortController()
    const { deps, store, paylinkService, linkFor } = makeDeps([event({})])
    if (stage === "events") {
      deps.source.listIncoming.mockImplementation(async () => {
        controller.abort()
        return [event({})]
      })
    } else if (stage === "note") {
      paylinkService.sync_note.mockImplementation(async () => {
        controller.abort()
        return { claimableFrom: 100, claimableUntil: 200, refundableUntil: 200 }
      })
    } else {
      linkFor.mockImplementation(async () => {
        controller.abort()
        return "https://link/0x1"
      })
    }

    expect(await rebuildPaylinks({ ...deps, signal: controller.signal })).toEqual([])
    expect(store.addRecoveredPaylinkTransaction).not.toHaveBeenCalled()
  })
})
