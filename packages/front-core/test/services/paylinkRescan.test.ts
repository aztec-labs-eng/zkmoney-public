import { afterEach, describe, expect, it, vi } from "vitest"
import { PaylinkActionEnum } from "@obsidion/core/constants"
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
    addRecoveredPaylinkPayout: vi.fn(async () => true),
    updateTransaction: vi.fn(async () => false),
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
    expect(paylinkService.recoverPaylinkFromTransfer).toHaveBeenCalledWith(
      expect.anything(),
      MASTER_SECRET,
    )
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

  it("defers a link whose note cannot be read", async () => {
    const { deps, store } = makeDeps([event({ txHash: "0x1" })], {
      sync_note: vi.fn().mockRejectedValue(new Error("not synced")),
    })

    expect(await rebuildPaylinks(deps)).toEqual([])
    expect(store.addRecoveredPaylinkTransaction).not.toHaveBeenCalled()
  })

  const CLAIMED = { isClaimed: true }
  const REFUNDED = { isRefunded: true, refundTxHash: "0xpayout" }
  it.each([
    ["no payout: someone else claimed it", {}, undefined, CLAIMED, undefined],
    [
      "an empty payout carrying the verified lane: a self-claim",
      { memo: undefined },
      { paylinkPayout: lane },
      CLAIMED,
      PaylinkActionEnum.CLAIM,
    ],
    [
      "a payout forwarding the tag: a self-claim",
      { senderTag: "me", memo: undefined },
      { senderTag: "me" },
      CLAIMED,
      PaylinkActionEnum.CLAIM,
    ],
    [
      "a payout forwarding the memo: a self-claim",
      { memo: "lunch" },
      { memo: "lunch" },
      CLAIMED,
      PaylinkActionEnum.CLAIM,
    ],
    [
      "an empty payout of a tagged link: a refund",
      { senderTag: "me", memo: "lunch" },
      {},
      REFUNDED,
      PaylinkActionEnum.CLAIM_BACK,
    ],
    [
      "an empty payout of a bare link: a refund by default",
      { memo: undefined },
      {},
      REFUNDED,
      PaylinkActionEnum.CLAIM_BACK,
    ],
  ])("classifies a spent escrow with %s", async (_, fundingMeta, payoutMeta, row, payoutAction) => {
    const funding = event({ senderTag: undefined, ...fundingMeta })
    const payout = event({
      txHash: "0xpayout",
      from: "0xescrow",
      to: ME,
      blockNumber: 12,
      paylinkCreated: undefined,
      memo: undefined,
      senderTag: undefined,
      ...payoutMeta,
    })
    const { deps, store, paylinkService } = makeDeps(payoutMeta ? [funding, payout] : [funding], {
      isPaylinkClaimed: vi.fn(async () => true),
    })

    await rebuildPaylinks(deps)

    expect(paylinkService.sync_note).not.toHaveBeenCalled()
    const written = store.addRecoveredPaylinkTransaction.mock.calls[0]![0]
    expect(written).toMatchObject({ txHash: "0x1", untilClaimable: undefined, ...row })
    if (!("isRefunded" in row)) expect(written).not.toHaveProperty("isRefunded")
    if (payoutAction) {
      expect(store.addRecoveredPaylinkPayout).toHaveBeenCalledWith(
        expect.objectContaining({ action: payoutAction, txHash: "0xpayout", blockNumber: 12 }),
      )
    } else {
      expect(store.addRecoveredPaylinkPayout).not.toHaveBeenCalled()
    }
  })
})

describe("paylink rescan cursor", () => {
  const KEY = `@obsidion/paylink-rescan/cursor/v2/network-A/${ME}`

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
    const { deps } = makeDeps(
      [event({ txHash: "0x1", blockNumber: 10 }), event({ txHash: "0x2", blockNumber: 20 })],
      {
        sync_note: vi
          .fn()
          .mockResolvedValueOnce({ claimableFrom: 1, claimableUntil: 2, refundableUntil: 2 })
          .mockRejectedValueOnce(new Error("not synced")),
      },
    )
    await rebuildPaylinks({ ...deps, storage })
    expect(await storage.getItem(KEY)).toBe("19")

    const controller = new AbortController()
    controller.abort()
    await storage.setItem(KEY, "5")
    await rebuildPaylinks({ ...deps, storage, signal: controller.signal })
    expect(await storage.getItem(KEY)).toBe("5")
  })

  describe("endpoint scope", () => {
    const SCOPED_KEY = `@obsidion/paylink-rescan/cursor/v2/network-A/A/${ME}`

    it("keeps the cursor under the scoped key and never touches the unscoped one", async () => {
      const storage = new InMemoryStorageAdapter()
      const getItem = vi.spyOn(storage, "getItem")
      const setItem = vi.spyOn(storage, "setItem")
      const { deps } = makeDeps([])
      await rebuildPaylinks({ ...deps, storage, endpointScope: "A" })
      const keys = [...getItem.mock.calls, ...setItem.mock.calls].map(([k]) => k)
      expect(keys.length).toBeGreaterThan(0)
      expect(keys.filter((k) => k !== SCOPED_KEY)).toEqual([])
      expect(await storage.getItem(SCOPED_KEY)).toBe("40")
      expect(await storage.getItem(KEY)).toBeNull()
    })

    it("uses the unscoped key without a scope", async () => {
      const storage = new InMemoryStorageAdapter()
      const setItem = vi.spyOn(storage, "setItem")
      const { deps } = makeDeps([])
      await rebuildPaylinks({ ...deps, storage })
      expect(setItem.mock.calls.map(([k]) => k)).toEqual([KEY])
    })

    it("a scoped pass advances its own cursor; the unscoped pass resumes from its older one", async () => {
      const storage = new InMemoryStorageAdapter()
      const { deps } = makeDeps([])
      const source = { ...deps.source, anchorBlock: vi.fn(async () => 200) }
      source.headBlock.mockResolvedValue(200)
      await storage.setItem(KEY, "100")

      await rebuildPaylinks({ ...deps, source, storage, endpointScope: "A" })
      expect(source.listIncoming).toHaveBeenLastCalledWith(1, 201) // cursorless under A
      expect(await storage.getItem(SCOPED_KEY)).toBe("200")
      expect(await storage.getItem(KEY)).toBe("100")

      await rebuildPaylinks({ ...deps, source, storage })
      expect(source.listIncoming).toHaveBeenLastCalledWith(100 - 64, 201)
      expect(await storage.getItem(KEY)).toBe("200")
      expect(await storage.getItem(SCOPED_KEY)).toBe("200")
    })
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

  it("turns a refunded link's send and payout receive into one refunded PAY row", async () => {
    const payout = event({
      txHash: "0x2",
      from: "0xescrow",
      to: ME,
      paylinkCreated: undefined,
      memo: undefined,
    })
    const { deps } = makeDeps([event({}), payout], { isPaylinkClaimed: vi.fn(async () => true) })
    const adapter = new InMemoryStorageAdapter()
    await adapter.setItem(TRANSACTIONS_STORAGE_KEY, "[]")
    const storage = TransactionStorage.get(adapter)
    const token = { ...TOKEN, name: "DAI", logo: "", amount: 2.5, price: 0 }
    const row = { token, timestamp: 1_000, networkId: "network-A", senderL2Address: ME }
    await storage.addIncomingTokenTransaction({
      ...row,
      action: "send",
      txHash: "0x1",
      from: ME,
      to: "0xescrow",
    })
    await storage.addIncomingTokenTransaction({
      ...row,
      action: "receive",
      txHash: "0x2",
      from: "0xescrow",
      to: ME,
    })

    await rebuildPaylinks({ ...deps, store: storage })

    const rows = await storage.getTransactions()
    expect(rows).toEqual([
      expect.objectContaining({
        txHash: "0x1",
        action: PaylinkActionEnum.PAY,
        isRefunded: true,
        isClaimed: false,
        refundTxHash: "0x2",
      }),
      expect.objectContaining({ txHash: "0x2", action: PaylinkActionEnum.CLAIM_BACK }),
    ])
    expect(rows[0]).not.toHaveProperty("paylink")
    // The transfer scanner now sees the payout as filed.
    expect(await storage.hasTxHash("0x2")).toBe(true)
  })

  it("settles a PAY row that read claimed once its refund payout lands", async () => {
    const funding = event({})
    const payout = event({
      txHash: "0x2",
      from: "0xescrow",
      to: ME,
      blockNumber: 12,
      paylinkCreated: undefined,
      memo: undefined,
    })
    const { deps } = makeDeps([funding], { isPaylinkClaimed: vi.fn(async () => true) })
    const adapter = new InMemoryStorageAdapter()
    await adapter.setItem(TRANSACTIONS_STORAGE_KEY, "[]")
    const storage = TransactionStorage.get(adapter)

    // The funding event is decrypted before the payout: the link reads claimed by someone else.
    await rebuildPaylinks({ ...deps, store: storage })
    expect(await storage.getTransactions()).toEqual([
      expect.objectContaining({ txHash: "0x1", isClaimed: true, paylink: "https://link/0x1" }),
    ])

    deps.source.listIncoming.mockResolvedValue([funding, payout])
    await rebuildPaylinks({ ...deps, store: storage })
    await rebuildPaylinks({ ...deps, store: storage }) // idempotent
    const rows = await storage.getTransactions()
    expect(rows).toEqual([
      expect.objectContaining({
        txHash: "0x1",
        isRefunded: true,
        isClaimed: false,
        refundTxHash: "0x2",
      }),
      expect.objectContaining({ txHash: "0x2", action: PaylinkActionEnum.CLAIM_BACK }),
    ])
    expect(rows[0]).not.toHaveProperty("paylink")
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

  it.each(["events", "note", "link"])(
    "does not write after disposal during %s discovery",
    async (stage) => {
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
    },
  )
})
