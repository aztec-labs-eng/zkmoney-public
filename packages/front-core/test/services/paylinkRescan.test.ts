import { describe, expect, it, vi } from "vitest"
import { PaylinkActionEnum } from "@obsidion/core/constants"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { ScannedTransferEvent } from "@obsidion/sdk"
import { rebuildPaylinks } from "../../src/core/services/paylink/paylinkRescan"

import { scannedRow } from "../../src/core/services/transactions/TransferEventScanner"
import { memoryBackend, type MemoryBackend } from "../../src/engine/memoryBackend"
import { deriveNotifications } from "../../src/engine/notificationFeed"
import { isOld, NOTIFICATION_WINDOW_MS } from "../../src/engine/notifications"
import { createOperations } from "../../src/engine/operations"
import { linkedActivity } from "../../src/engine/paylinks"
import { loadRecords } from "../../src/engine/persistentStore"
import type { PaylinkTransaction, Transaction } from "../../src/types/transactions"
import { seededActivity } from "../utils/transferFixture"

type Storage = ReturnType<typeof seededActivity>

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

// Each link has its own secret, and its identity is derived from it.
const params = (txHash: string) => ({
  secret: txHash === "0x1" ? secret : Fr.fromString(txHash),
  fallbackSecret,
  classId: Fr.ZERO,
  chainId: 31337,
  rollupVersion: 1,
  txHash,
  paylinkType: "paylinkDirect" as const,
  amount: 2_500_000_000_000_000_000n,
  email: undefined,
})

function makeDeps(
  events: ScannedTransferEvent[],
  over: Record<string, unknown> = {},
  backend: MemoryBackend = memoryBackend(),
) {
  const store = seededActivity(
    [
      {
        action: PaylinkActionEnum.PAY,
        emailPaymentAction: PaylinkActionEnum.PAY,
        flavor: "direct",
        payToEmailSecret: "0xknown",
        txHash: "0xknown",
        timestamp: 1,
        status: "success",
      } as Partial<Transaction>,
    ],
    { backend },
  )
  vi.spyOn(store, "record")
  const paylinkService = {
    recoverPaylinkFromTransfer: vi.fn(async (e: ScannedTransferEvent) =>
      e.to === "0xescrow" ? params(e.txHash) : null,
    ),
    paylinkClaimBlock: vi.fn(async (): Promise<number | undefined> => undefined),
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
        blockTimestampMs: vi.fn(async (b: number) =>
          b === 10 ? 1_000 : b === 12 ? 5_000 : undefined,
        ),
      },
      accountAddress: ME.toUpperCase(),
      masterSecret: MASTER_SECRET,
      networkId: "network-A",
      paylinkService: paylinkService as never,
      linkFor,
      store,
      links: store.paylinks,
      db: store.db,
      token: TOKEN,
      now: () => 9_999,
    },
    store,
    backend,
    paylinkService,
    linkFor,
  }
}

/** The payouts the rescan recorded, which replace a receive. */
const payouts = (store: { record: unknown }): Transaction[] =>
  vi
    .mocked(store.record as (row: Transaction, opts?: { replaces?: string }) => unknown)
    .mock.calls.filter(([row]) => row.action !== PaylinkActionEnum.PAY)
    .map(([row]) => row)

/** Every row, each link on its funding row. */
const rowsOf = (store: Storage) =>
  linkedActivity(store, store.paylinks, createOperations({ db: store.db, now: () => Date.now() }))

/** The links the rescan filed, on their funding rows, oldest first. */
const filed = async (store: Storage) =>
  (await rowsOf(store)).filter(
    (row) => (row as PaylinkTransaction).payToEmailSecret && row.txHash !== "0xknown",
  )

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

    const { created, complete } = await rebuildPaylinks(deps)

    expect(deps.source.listIncoming).toHaveBeenCalledWith(1, 41)
    expect(created.map((r) => r.txHash)).toEqual(["0x1", "0x2"])
    expect(complete).toBe(true)
    expect(paylinkService.recoverPaylinkFromTransfer).toHaveBeenCalledTimes(3)
    expect(paylinkService.recoverPaylinkFromTransfer).toHaveBeenCalledWith(
      expect.anything(),
      MASTER_SECRET,
    )
    expect((await filed(store))[0]).toMatchObject({
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
      networkId: "network-a",
      token: { symbol: "DAI", amount: 2.5, price: 1 },
    })
    expect((await filed(store))[1]).toMatchObject({
      txHash: "0x2",
      timestamp: 9_999,
    })
  })

  it("defers a link whose note cannot be read, and says the pass is not complete", async () => {
    const { deps, store } = makeDeps([event({ txHash: "0x1" })], {
      sync_note: vi.fn().mockRejectedValue(new Error("not synced")),
    })

    expect(await rebuildPaylinks(deps)).toEqual({ created: [], complete: false })
    expect(await filed(store)).toEqual([])
  })

  it("is not complete when aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const { deps } = makeDeps([event({ txHash: "0x1" })])

    expect(await rebuildPaylinks({ ...deps, signal: controller.signal })).toEqual({
      created: [],
      complete: false,
    })
  })

  // Claimed at the claim's block, whose time the source reads as 5_000.
  const CLAIMED = { isClaimed: true, claimedAt: 5_000, claimedBy: "self" }
  // Refunded 4 s after its funding: a cancel.
  const REFUNDED = { isRefunded: true, refundTxHash: "0xpayout", refundKind: "cancel" }
  it.each([
    [
      "no payout: someone else claimed it",
      {},
      undefined,
      { ...CLAIMED, claimedBy: "chain" },
      undefined,
    ],
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
      paylinkClaimBlock: vi.fn(async () => 12),
    })

    await rebuildPaylinks(deps)

    expect(paylinkService.sync_note).not.toHaveBeenCalled()
    const written = (await filed(store))[0]
    expect(written).toMatchObject({ txHash: "0x1", ...row })
    expect((written as PaylinkTransaction).untilClaimable).toBeUndefined()
    if (!("isRefunded" in row)) expect(written).not.toHaveProperty("isRefunded")
    if (!("isClaimed" in row)) expect(written).not.toHaveProperty("claimedAt")
    if (payoutAction) {
      expect(payouts(store)).toEqual([
        expect.objectContaining({ action: payoutAction, txHash: "0xpayout", blockNumber: 12 }),
      ])
    } else {
      expect(payouts(store)).toEqual([])
    }
  })
})

describe("a rebuilt refund's kind", () => {
  const HOUR = 3_600_000
  const payout = event({
    txHash: "0xpayout",
    from: "0xescrow",
    to: ME,
    blockNumber: 12,
    paylinkCreated: undefined,
    memo: undefined,
  })
  const atTimes = (deps: ReturnType<typeof makeDeps>["deps"], payoutAt: number | undefined) =>
    deps.source.blockTimestampMs.mockImplementation(async (b: number) =>
      b === 10 ? 1_000 : b === 12 ? payoutAt : undefined,
    )

  // Another device reads "Cancelled" where the creator's device does, not "Refunded".
  it.each([
    ["a cancel within a day of its funding", 1_000 + 22 * HOUR, "cancel"],
    ["unnamed later, with no expiry to read", 1_000 + 30 * HOUR, undefined],
    ["unnamed with no block time for it", undefined, undefined],
  ])("reads a spent link's refund as %s", async (_, payoutAt, kind) => {
    const { deps, store } = makeDeps([event({}), payout], {
      paylinkClaimBlock: vi.fn(async () => 12),
    })
    atTimes(deps, payoutAt)

    await rebuildPaylinks(deps)

    const [written] = await filed(store)
    expect(written).toMatchObject({ isRefunded: true })
    expect((written as { refundKind?: string }).refundKind).toBe(kind)
  })

  it.each([
    ["a cancel before it", 150_000, "cancel"],
    ["a reclaim after it", 300_000, "reclaim"],
    ["unnamed with no block time for it", undefined, undefined],
  ])("reads a refund landing on a row that kept its expiry as %s", async (_, at, kind) => {
    const { deps } = makeDeps([event({})])
    const storage = seededActivity()
    const pass = () =>
      rebuildPaylinks({ ...deps, store: storage, links: storage.paylinks, db: storage.db })
    // Rebuilt while unspent: its note gives the expiry, 200 s.
    await pass()

    deps.source.listIncoming.mockResolvedValue([event({}), payout])
    atTimes(deps, at)
    await pass()

    const link = (await rowsOf(storage)).find((r) => r.txHash === "0x1") as PaylinkTransaction
    expect(link).toMatchObject({ isRefunded: true })
    expect(link.refundKind).toBe(kind)
  })
})

describe("paylink rescan cursor", () => {
  const KEY = `acct/paylinkRescanCursor/network-A/${ME}`
  const cursors = (backend: MemoryBackend) =>
    [...backend.entries.keys()].filter((k) => k.startsWith("acct/paylinkRescanCursor/"))

  it("resumes a reorg margin behind the saved cursor and saves PXE's synced block", async () => {
    const { deps, backend } = makeDeps([])
    const source = { ...deps.source, anchorBlock: vi.fn(async () => 38) }
    await rebuildPaylinks({ ...deps, source })
    expect(source.listIncoming).toHaveBeenLastCalledWith(1, 41)
    expect(backend.entries.get(KEY)).toBe("38")

    backend.entries.set(KEY, "100")
    await rebuildPaylinks({ ...deps, source })
    expect(source.listIncoming).toHaveBeenLastCalledWith(1, 41)
    expect(backend.entries.get(KEY)).toBe("38")

    backend.entries.set(KEY, "30")
    source.headBlock.mockResolvedValue(200)
    source.anchorBlock.mockResolvedValue(200)
    await rebuildPaylinks({ ...deps, source })
    expect(source.listIncoming).toHaveBeenLastCalledWith(1, 201)
    await rebuildPaylinks({ ...deps, source })
    expect(source.listIncoming).toHaveBeenLastCalledWith(200 - 64, 201)
  })

  it("resumes from an older build's cursor and never writes it", async () => {
    const { deps, backend } = makeDeps([])
    const OLDER = `@obsidion/paylink-rescan/cursor/v2/network-A/${ME}`
    backend.entries.set(OLDER, "150")
    deps.source.headBlock.mockResolvedValue(200)
    await rebuildPaylinks(deps)
    expect(deps.source.listIncoming).toHaveBeenLastCalledWith(150 - 64, 201)
    expect(backend.entries.get(KEY)).toBe("200")
    expect(backend.entries.get(OLDER)).toBe("150")
  })

  it("keeps neither the rebuilt rows nor the cursor when their save fails", async () => {
    const { deps, store, backend } = makeDeps([event({ txHash: "0x1", blockNumber: 10 })])
    await store.ready
    backend.failing.commits = true
    await expect(rebuildPaylinks(deps)).rejects.toMatchObject({ code: "unknown" })
    expect(await store.hasTxHash("0x1")).toBe(false)
    expect(backend.entries.get(KEY)).toBeUndefined()
    backend.failing.commits = false
    expect((await rebuildPaylinks(deps)).created.map((r) => r.txHash)).toEqual(["0x1"])
    expect(backend.entries.get(KEY)).toBe("40")
  })

  it("holds the cursor below a link whose note is not readable yet, and saves nothing when aborted", async () => {
    const { deps, backend } = makeDeps(
      [event({ txHash: "0x1", blockNumber: 10 }), event({ txHash: "0x2", blockNumber: 20 })],
      {
        sync_note: vi
          .fn()
          .mockResolvedValueOnce({ claimableFrom: 1, claimableUntil: 2, refundableUntil: 2 })
          .mockRejectedValueOnce(new Error("not synced")),
      },
    )
    await rebuildPaylinks(deps)
    expect(backend.entries.get(KEY)).toBe("19")

    const controller = new AbortController()
    controller.abort()
    backend.entries.set(KEY, "5")
    await rebuildPaylinks({ ...deps, signal: controller.signal })
    expect(backend.entries.get(KEY)).toBe("5")
  })

  describe("endpoint scope", () => {
    const SCOPED_KEY = `acct/paylinkRescanCursor/network-A/A/${ME}`

    it("keeps the cursor under the scoped key and never touches the unscoped one", async () => {
      const { deps, backend } = makeDeps([])
      await rebuildPaylinks({ ...deps, endpointScope: "A" })
      expect(cursors(backend)).toEqual([SCOPED_KEY])
      expect(backend.entries.get(SCOPED_KEY)).toBe("40")
    })

    it("uses the unscoped key without a scope", async () => {
      const { deps, backend } = makeDeps([])
      await rebuildPaylinks(deps)
      expect(cursors(backend)).toEqual([KEY])
    })

    it("a scoped pass advances its own cursor; the unscoped pass resumes from its older one", async () => {
      const { deps, backend } = makeDeps([])
      const source = { ...deps.source, anchorBlock: vi.fn(async () => 200) }
      source.headBlock.mockResolvedValue(200)
      backend.entries.set(KEY, "100")

      await rebuildPaylinks({ ...deps, source, endpointScope: "A" })
      expect(source.listIncoming).toHaveBeenLastCalledWith(1, 201) // cursorless under A
      expect(backend.entries.get(SCOPED_KEY)).toBe("200")
      expect(backend.entries.get(KEY)).toBe("100")

      await rebuildPaylinks({ ...deps, source })
      expect(source.listIncoming).toHaveBeenLastCalledWith(100 - 64, 201)
      expect(backend.entries.get(KEY)).toBe("200")
      expect(backend.entries.get(SCOPED_KEY)).toBe("200")
    })
  })
})

describe("paylink rescan ownership", () => {
  it.each(["send-first", "paylink-first"])("keeps one complete PAY row when %s", async (order) => {
    const { deps } = makeDeps([event({})])
    const storage = seededActivity()
    const writeSend = () =>
      storage.record(
        scannedRow({
          action: "send",
          txHash: "0x1",
          from: ME,
          senderL2Address: ME,
          to: "0xescrow",
          token: { ...TOKEN, name: "DAI", logo: "", amount: 2.5, price: 0 },
          amountAtomic: 2_500_000_000_000_000_000n,
          timestamp: 1_000,
          networkId: "network-A",
        }),
      )
    if (order === "send-first") await writeSend()
    expect(
      (await rebuildPaylinks({ ...deps, store: storage, links: storage.paylinks, db: storage.db }))
        .created,
    ).toHaveLength(1)
    // Also covers a scanner that passed its hasTxHash check before recovery wrote.
    if (order === "paylink-first") await writeSend()
    expect(
      (await rebuildPaylinks({ ...deps, store: storage, links: storage.paylinks, db: storage.db }))
        .created,
    ).toEqual([])
    expect(await rowsOf(storage)).toEqual([
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
    const { deps } = makeDeps([event({}), payout], { paylinkClaimBlock: vi.fn(async () => 12) })
    const storage = seededActivity()
    const token = { ...TOKEN, name: "DAI", logo: "", amount: 2.5, price: 0 }
    const row = {
      token,
      amountAtomic: 2_500_000_000_000_000_000n,
      timestamp: 1_000,
      networkId: "network-A",
      senderL2Address: ME,
    }
    await storage.record(
      scannedRow({ ...row, action: "send", txHash: "0x1", from: ME, to: "0xescrow" }),
    )
    await storage.record(
      scannedRow({ ...row, action: "receive", txHash: "0x2", from: "0xescrow", to: ME }),
    )

    await rebuildPaylinks({ ...deps, store: storage, links: storage.paylinks, db: storage.db })

    const rows = await rowsOf(storage)
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
    expect((rows[0] as { paylink?: string }).paylink).toBeUndefined()
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
    const { deps } = makeDeps([funding], { paylinkClaimBlock: vi.fn(async () => 12) })
    const storage = seededActivity()

    // The funding event is decrypted before the payout: the link reads claimed by someone else.
    await rebuildPaylinks({ ...deps, store: storage, links: storage.paylinks, db: storage.db })
    expect(await rowsOf(storage)).toEqual([
      expect.objectContaining({ txHash: "0x1", isClaimed: true, paylink: "https://link/0x1" }),
    ])

    deps.source.listIncoming.mockResolvedValue([funding, payout])
    await rebuildPaylinks({ ...deps, store: storage, links: storage.paylinks, db: storage.db })
    await rebuildPaylinks({ ...deps, store: storage, links: storage.paylinks, db: storage.db }) // idempotent
    const rows = await rowsOf(storage)
    expect(rows).toEqual([
      expect.objectContaining({
        txHash: "0x1",
        isRefunded: true,
        isClaimed: false,
        refundTxHash: "0x2",
      }),
      expect.objectContaining({ txHash: "0x2", action: PaylinkActionEnum.CLAIM_BACK }),
    ])
    expect((rows[0] as { paylink?: string }).paylink).toBeUndefined()
  })

  it("persists the source network", async () => {
    const { deps } = makeDeps([event({})])
    const storage = seededActivity()

    await rebuildPaylinks({ ...deps, store: storage, links: storage.paylinks, db: storage.db })

    expect(await rowsOf(storage)).toEqual([
      expect.objectContaining({ txHash: "0x1", networkId: "network-a" }),
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

      expect((await rebuildPaylinks({ ...deps, signal: controller.signal })).created).toEqual([])
      expect(await filed(store)).toEqual([])
    },
  )
})

describe("a rebuilt claim in the bell", () => {
  // The link was funded at 1_000 and claimed at 5_000: a day after the claim, its creation is old.
  const now = 5_000 + NOTIFICATION_WINDOW_MS - 1
  async function rebuiltClaim(...passes: ScannedTransferEvent[][]) {
    const storage = seededActivity()
    for (const events of passes) {
      const { deps } = makeDeps(events, { paylinkClaimBlock: vi.fn(async () => 12) })
      await rebuildPaylinks({ ...deps, store: storage, links: storage.paylinks, db: storage.db })
    }
    const sources = {
      rows: await storage.all(),
      links: await loadRecords(storage.paylinks.view),
      oldVersionWithdrawals: [],
      bridgeIns: { records: [], hydrated: true },
      deposits: { records: [], loaded: true, failed: false },
      withdrawals: { records: [], hydrated: true },
      upgrades: { items: [], recipients: new Set<string>(), loaded: true },
      processing: new Map(),
      registrations: [],
      operations: { ended: [], running: [] },
      loaded: true,
    }
    return deriveNotifications(sources, new Map(), now).filter((e) => e.id.startsWith("paylink:"))
  }

  it("rings for a link another account claimed within the window, whenever it was made", async () => {
    const [entry] = await rebuiltClaim([event({})])
    expect(entry).toMatchObject({ timestampMs: 5_000, settledAt: 5_000 })
    expect(isOld(entry!, () => false, now)).toBe(false)
  })

  it("stays quiet for a link this account claimed itself", async () => {
    const payout = event({
      txHash: "0xpayout",
      from: "0xescrow",
      to: ME,
      blockNumber: 12,
      paylinkCreated: undefined,
      paylinkPayout: lane,
      memo: undefined,
    })
    expect(await rebuiltClaim([event({}), payout])).toEqual([])
  })

  it("stays quiet once its payout to this account turns up in a later pass", async () => {
    const payout = event({
      txHash: "0xpayout",
      from: "0xescrow",
      to: ME,
      blockNumber: 12,
      paylinkCreated: undefined,
      paylinkPayout: lane,
      memo: undefined,
    })
    expect(await rebuiltClaim([event({})], [event({}), payout])).toEqual([])
  })
})
