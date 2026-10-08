import { describe, expect, it, vi } from "vitest"
import { buildChatMessages } from "../../../src/core/paymentsChat"
import type { IStorageAdapter } from "../../../src/core/storages/adapter"
import type { TokenTransaction } from "../../../src/types/transactions"
import type { NewIncomingTokenTx, NewPaylinkPayoutTx } from "../../../src/xmtp/receiverTypes"
import {
  TransferEventScanner,
  TRANSFER_SCAN_CATCH_UP_BLOCKS,
  TRANSFER_SCAN_REORG_MARGIN,
  type ScannedTransferEvent,
  type TransferEventSource,
} from "../../../src/core/services/transactions/TransferEventScanner"
import { fakeIncomingTokenTx, makeScheduler } from "../../utils/xmtpReceiveFixtures"
import { globalEventEmitter } from "../../../src/core/services/GlobalEventEmitter"

vi.mock("@obsidion/sdk", () => ({
  QueueStatus: { CANCELLED: "cancelled", FAILED: "failed", PENDING: "pending" },
}))

const ME = "0x" + "aa".repeat(32)
const ALICE = "0x" + "bb".repeat(32)
const MALLORY = "0x" + "cc".repeat(32)
const TOKEN = { address: "0x" + "11".repeat(32), symbol: "DAI", decimals: 6 }

function memStorage(): IStorageAdapter {
  const m = new Map<string, string>()
  return {
    getItem: async (k) => m.get(k) ?? null,
    setItem: async (k, v) => void m.set(k, v),
    removeItem: async (k) => void m.delete(k),
    clear: async () => m.clear(),
  }
}

function event(overrides: Partial<ScannedTransferEvent> = {}): ScannedTransferEvent {
  return {
    txHash: "0x" + "01".repeat(32),
    from: ALICE,
    to: ME,
    amount: "5000000",
    blockNumber: 10,
    senderTag: "alice",
    ...overrides,
  }
}

function harness(opts: {
  contactTag?: string
  events?: ScannedTransferEvent[]
  head?: number | (() => number)
  /** PXE synced block; unset means the source has no anchorBlock. */
  anchor?: () => number
  /** Range-aware event source; wins over `events`. */
  list?: (fromBlock: number, toBlockExclusive: number) => ScannedTransferEvent[]
  resolve?: (tag: string) => Promise<{ l2Address: string } | null>
  /** Hashes already held by a row of some OTHER action (a paylink claim/refund). */
  otherRowHashes?: string[]
  /** Throw from the store write, to exercise a poison event. */
  addThrows?: () => boolean
  onSynced?: (anchor: number) => Promise<void>
  /** Block time read; defaults to `block * 1000`. Undefined means the node could not serve it. */
  blockTime?: (block: number) => number | undefined
}) {
  const rows = new Map<string, TokenTransaction>()
  const adds: NewIncomingTokenTx[] = []
  const payouts: NewPaylinkPayoutTx[] = []
  const registered: { tag: string; l2Address: string }[] = []
  const listIncoming = vi.fn(async (a: number, b: number) =>
    opts.list ? opts.list(a, b) : opts.events ?? [],
  )
  const source: TransferEventSource = {
    headBlock: async () => (typeof opts.head === "function" ? opts.head() : opts.head ?? 100),
    listIncoming,
    blockTimestampMs: async (b) => (opts.blockTime ? opts.blockTime(b) : b * 1000),
    ...(opts.anchor ? { anchorBlock: async () => opts.anchor!() } : {}),
  }
  const scheduler = makeScheduler()
  const storage = memStorage()
  /** The persisted cursor, read straight from storage — call args are not proof of state. */
  const cursor = async () =>
    Number(await storage.getItem(`@obsidion/transfer-scan/cursor/v1/net/${ME}`))
  const scanner = new TransferEventScanner({
    source,
    storage,
    transactionStore: {
      hasTxHash: async (h) =>
        (opts.otherRowHashes ?? []).includes(h.toLowerCase()) || rows.has(h.toLowerCase()),
      addIncomingTokenTransaction: async (input) => {
        if (opts.addThrows?.()) throw new Error("store write failed")
        adds.push(input)
        const tx = fakeIncomingTokenTx(input)
        rows.set(input.txHash.toLowerCase(), tx)
        return { tx, inserted: true }
      },
      addRecoveredPaylinkPayout: async (input) => {
        payouts.push(input)
        rows.set(
          input.txHash.toLowerCase(),
          fakeIncomingTokenTx({ ...input, from: "", senderL2Address: "", to: ME }),
        )
        return true
      },
    },
    tags: {
      resolveL2: opts.resolve ?? (async (tag) => (tag === "alice" ? { l2Address: ALICE } : null)),
    },
    contacts: {
      findByL2Address: async () => (opts.contactTag ? { tag: opts.contactTag } : null),
      registerL2: async (args) => void registered.push(args),
    },
    token: TOKEN,
    onSynced: opts.onSynced,
    scheduler,
    now: () => 777,
  })
  const ctx = { accountAddress: ME, accountTag: "me", networkId: "net" }
  return { scanner, ctx, adds, payouts, rows, registered, listIncoming, scheduler, cursor, storage }
}

describe("TransferEventScanner", () => {
  it("files a receive with a verified payout lane as a paylink claim, not a receive", async () => {
    const lane = { flavor: "direct" as const, secret: {} as never, fallbackKeyHash: {} as never }
    const h = harness({
      events: [
        event({ paylinkPayout: lane, senderTag: "notme", memo: "lunch" }),
        event({ txHash: "0x" + "02".repeat(32) }),
      ],
    })
    await h.scanner.start(h.ctx)
    expect(h.payouts).toEqual([
      expect.objectContaining({
        action: "Claim With Email",
        txHash: "0x" + "01".repeat(32),
        flavor: "direct",
        memo: "lunch",
        blockNumber: 10,
        timestamp: 10_000,
        networkId: "net",
      }),
    ])
    expect(h.adds.map((a) => a.txHash)).toEqual(["0x" + "02".repeat(32)])
    await h.scanner.tickNow()
    expect(h.payouts).toHaveLength(2) // re-offered each pass; the store upgrades only a plain receive
    h.scanner.stop()
  })

  it("upgrades a payout filed as a plain receive before its lane was read", async () => {
    const lane = { flavor: "direct" as const, secret: {} as never, fallbackKeyHash: {} as never }
    const h = harness({ events: [event({ paylinkPayout: lane })] })
    h.rows.set(event().txHash, fakeIncomingTokenTx(event() as never))
    await h.scanner.start(h.ctx)
    expect(h.adds).toEqual([])
    expect(h.payouts.map((p) => p.txHash)).toEqual([event().txHash])
    h.scanner.stop()
  })

  it("records head and the clock as the join point on the cursorless first pass only", async () => {
    let head = 100
    const h = harness({ events: [event()], head: () => head })
    const joined = async () =>
      JSON.parse((await h.storage.getItem(`@obsidion/transfer-scan/joined/v1/net/${ME}`))!)
    await h.scanner.start(h.ctx)
    expect(await joined()).toEqual({ block: 100, ms: 777 })
    head = 200
    await h.scanner.tickNow()
    expect(await joined()).toEqual({ block: 100, ms: 777 })
    h.scanner.stop()
  })

  it("flags catch-up for the cursorless first pass, and clears it when that pass ends", async () => {
    const seen: boolean[] = []
    const listener = (v: boolean) => void seen.push(v)
    globalEventEmitter.onSyncCatchUpChanged(listener)
    const h = harness({ events: [event()] })
    await h.scanner.start(h.ctx)
    expect(seen).toEqual([true, false])
    expect(globalEventEmitter.isSyncCatchingUp()).toBe(false)
    await h.scanner.tickNow()
    expect(seen).toEqual([true, false]) // cursor present: a normal reopen never flags
    h.scanner.stop()

    // Nested holders (withdrawal rescan, deposit sync) collapse into one true/false pair.
    const endA = globalEventEmitter.beginSyncCatchUp()
    const endB = globalEventEmitter.beginSyncCatchUp()
    endA()
    endA()
    expect(globalEventEmitter.isSyncCatchingUp()).toBe(true)
    endB()
    expect(seen).toEqual([true, false, true, false])
    globalEventEmitter.offSyncCatchUpChanged(listener)
  })

  it("holds catch-up only when the cursor lags head by more than the catch-up distance", async () => {
    const seen: boolean[] = []
    const listener = (v: boolean) => void seen.push(v)
    globalEventEmitter.onSyncCatchUpChanged(listener)
    let head = 100
    const h = harness({ events: [event()], head: () => head })
    await h.scanner.start(h.ctx) // cursorless first pass
    head = 100 + TRANSFER_SCAN_CATCH_UP_BLOCKS
    await h.scanner.tickNow() // an hours-long gap is still a routine reopen: rows land live
    expect(seen).toEqual([true, false])
    head += TRANSFER_SCAN_CATCH_UP_BLOCKS + 1
    await h.scanner.tickNow() // far behind head: rows land behind the skeleton
    expect(seen).toEqual([true, false, true, false])
    h.scanner.stop()
    globalEventEmitter.offSyncCatchUpChanged(listener)
  })

  it("writes a verified receive attributed to the sender's tag and auto-adds the contact", async () => {
    const h = harness({ events: [event({ requestId: "0x" + "0c".repeat(32), memo: "hi" })] })
    await h.scanner.start(h.ctx)
    expect(h.adds).toHaveLength(1)
    expect(h.adds[0]).toMatchObject({
      from: "alice",
      senderL2Address: ALICE,
      to: "me",
      memo: "hi",
      requestId: "0x" + "0c".repeat(32),
      amountAtomic: "5000000",
      blockNumber: 10,
      timestamp: 10_000,
    })
    expect(h.adds[0]!.token).toMatchObject({ address: TOKEN.address, symbol: "DAI", amount: 5 })
    expect(h.registered).toEqual([{ tag: "alice", l2Address: ALICE }])
    h.scanner.stop()
  })

  it("falls back to the raw address and adds no contact when the tag does not resolve to the sender", async () => {
    const h = harness({ events: [event({ from: MALLORY, senderTag: "alice" })] })
    await h.scanner.start(h.ctx)
    expect(h.adds[0]!.from).toBe(MALLORY)
    expect(h.registered).toEqual([])
    h.scanner.stop()
  })

  it("skips self-transfers, other accounts' transfers, and already-stored hashes", async () => {
    const h = harness({
      events: [
        event({ from: ME, txHash: "0x" + "02".repeat(32) }),
        event({ from: ALICE, to: MALLORY, txHash: "0x" + "03".repeat(32) }),
        event(),
        event(),
      ],
    })
    await h.scanner.start(h.ctx)
    expect(h.adds).toHaveLength(1)
    h.scanner.stop()
  })

  it("adopts a send's recipient tag as a contact once the registry resolves it to the recipient", async () => {
    const h = harness({
      events: [
        event({ from: ME, to: ALICE, recipientTag: "alice", txHash: "0x" + "04".repeat(32) }),
        event({ from: ME, to: MALLORY, recipientTag: "alice", txHash: "0x" + "05".repeat(32) }),
      ],
    })
    await h.scanner.start(h.ctx)
    expect(h.adds.map((a) => a.to)).toEqual([ALICE, MALLORY])
    expect(h.registered).toEqual([{ tag: "alice", l2Address: ALICE }])
    h.scanner.stop()
  })

  it("holds the cursor when the recipient-tag registry read fails, like a receive", async () => {
    const h = harness({
      events: [event({ from: ME, to: ALICE, recipientTag: "alice" })],
      resolve: async () => {
        throw new Error("registry down")
      },
    })
    await h.scanner.start(h.ctx)
    expect(h.adds).toHaveLength(0)
    expect(await h.cursor()).toBe(0)
    h.scanner.stop()
  })

  it("sheds a hanging contact lookup on a send after repeated timeouts instead of stalling the cursor", async () => {
    const h = harness({ events: [event({ from: ME, to: ALICE, recipientTag: "alice" })] })
    const hung = h.scanner as unknown as {
      opts: { contacts: { findByL2Address: () => Promise<{ tag: string } | null> } }
    }
    Object.defineProperty(hung, "sourceTimeoutMs", { value: 20 })
    hung.opts.contacts.findByL2Address = () => new Promise(() => {})
    await h.scanner.start(h.ctx)
    expect(h.adds).toHaveLength(0)
    await h.scanner.tickNow()
    await h.scanner.tickNow()
    await h.scanner.tickNow()
    expect(h.adds).toHaveLength(1)
    expect(h.adds[0]).toMatchObject({ action: "send", to: ALICE })
    expect(h.registered).toEqual([])
    await h.scanner.tickNow()
    expect(h.listIncoming).toHaveBeenLastCalledWith(100 - TRANSFER_SCAN_REORG_MARGIN, 101)
    h.scanner.stop()
  })

  it("writes the account's own sends as send rows; no registry lookup without a recipient tag", async () => {
    const resolve = vi.fn(async () => null)
    const h = harness({
      events: [event({ from: ME, to: ALICE, senderTag: "me", memo: "rent" })],
      resolve,
    })
    await h.scanner.start(h.ctx)
    expect(resolve).not.toHaveBeenCalled()
    expect(h.adds).toHaveLength(1)
    expect(h.adds[0]).toMatchObject({
      action: "send",
      from: "me",
      to: ALICE,
      senderL2Address: ME,
      memo: "rent",
      amountAtomic: "5000000",
      blockNumber: 10,
    })
    expect(h.registered).toEqual([])
    h.scanner.stop()
  })

  it.each([undefined, "alice"])(
    "keeps rebuilt sends in contact history with saved tag %s",
    async (contactTag) => {
      const h = harness({ contactTag, events: [event({ from: ME, to: ALICE })] })
      try {
        await h.scanner.start(h.ctx)
        const messages = buildChatMessages(
          { id: "alice", name: "Alice", tag: "alice", address: ALICE },
          { transactions: [...h.rows.values()] },
        )
        expect(messages).toHaveLength(1)
        expect(messages[0]).toMatchObject({ role: "sent-confirmed", amount: "-$5.00" })
        expect(h.adds[0]?.to).toBe(ALICE)
      } finally {
        h.scanner.stop()
      }
    },
  )

  it("holds the cursor when the registry is unavailable and advances it once ingest succeeds", async () => {
    let fail = true
    const h = harness({
      events: [event()],
      resolve: async () => {
        if (fail) throw new Error("registry down")
        return { l2Address: ALICE }
      },
    })
    await h.scanner.start(h.ctx)
    expect(h.adds).toHaveLength(0)
    expect(h.listIncoming).toHaveBeenLastCalledWith(1, 101)

    fail = false
    await h.scanner.tickNow()
    expect(h.adds).toHaveLength(1)
    await h.scanner.tickNow()
    expect(h.listIncoming).toHaveBeenLastCalledWith(100 - TRANSFER_SCAN_REORG_MARGIN, 101)
    h.scanner.stop()
  })

  it("skips a Transfer whose hash a paylink row already holds", async () => {
    // The paylink escrow pays its claimant with the same token `transfer`, so a claim lands here
    // as an ordinary incoming Transfer. Matching only send/receive rows would file it twice.
    const claimHash = "0x" + "01".repeat(32)
    const h = harness({ events: [event({ txHash: claimHash })], otherRowHashes: [claimHash] })
    await h.scanner.start(h.ctx)
    expect(h.adds).toHaveLength(0)
    h.scanner.stop()
  })

  it("degrades to raw-address attribution after repeated registry failures instead of skipping", async () => {
    const h = harness({
      events: [event()],
      resolve: async () => {
        throw new Error("registry down")
      },
    })
    await h.scanner.start(h.ctx)
    expect(h.adds).toHaveLength(0)
    // Retried while it might still be transient, then the registry lookup is shed — never the event.
    await h.scanner.tickNow()
    await h.scanner.tickNow()
    await h.scanner.tickNow()
    expect(h.adds).toHaveLength(1)
    expect(h.adds[0]!.from).toBe(ALICE)
    expect(h.registered).toEqual([])
    // The chunk completed, so the cursor moved on.
    await h.scanner.tickNow()
    expect(h.listIncoming).toHaveBeenLastCalledWith(100 - TRANSFER_SCAN_REORG_MARGIN, 101)
    h.scanner.stop()
  })

  it("defers an event whose block time cannot be read, and dates it by chain once it can", async () => {
    let blockTime: number | undefined
    const h = harness({ events: [event()], blockTime: () => blockTime })
    await h.scanner.start(h.ctx)
    await h.scanner.tickNow()
    expect(h.adds).toHaveLength(0)
    expect(h.listIncoming).toHaveBeenLastCalledWith(1, 101) // cursor held, never stamped 777
    blockTime = 10_000
    await h.scanner.tickNow()
    expect(h.adds.map((a) => a.timestamp)).toEqual([10_000])
    h.scanner.stop()
  })

  it("holds the cursor for a persistently failing store write and never drops the event", async () => {
    const h = harness({ events: [event()], addThrows: () => true })
    await h.scanner.start(h.ctx)
    for (let i = 0; i < 5; i++) await h.scanner.tickNow()
    expect(h.adds).toHaveLength(0)
    // Still retrying the same range from block 1 — the event was never abandoned.
    expect(h.listIncoming).toHaveBeenLastCalledWith(1, 101)
    h.scanner.stop()
  })

  it("never persists the cursor past the PXE anchor, and ingests the gap once it catches up", async () => {
    // Head is the node tip; PXE (pinned during a send) has only synced to 40. A transfer sits at
    // block 70 — beyond the anchor, so PXE cannot return it yet, and below head minus the reorg
    // margin, so a cursor persisted at head would skip it for good.
    let anchor = 40
    const h = harness({
      head: 1_000,
      anchor: () => anchor,
      list: (a, b) => {
        const e = event({ blockNumber: 70 })
        return e.blockNumber >= a && e.blockNumber < b && e.blockNumber <= anchor ? [e] : []
      },
    })
    await h.scanner.start(h.ctx)
    expect(h.adds).toHaveLength(0)
    expect(await h.cursor()).toBe(40)

    // Anchor unchanged: the background tick rescans (re-triggering the sync) rather than idling.
    const calls = h.listIncoming.mock.calls.length
    await h.scheduler.advance(5_000)
    await new Promise((r) => setTimeout(r, 0)) // let the fired tick fully settle
    expect(h.listIncoming.mock.calls.length).toBe(calls + 1)
    expect(await h.cursor()).toBe(40)

    // Send finished, sync caught up: the block-70 payment lands and the cursor reaches head.
    anchor = 1_000
    await h.scanner.tickNow()
    expect(h.adds).toHaveLength(1)
    expect(await h.cursor()).toBe(1_000)
    h.scanner.stop()
  })

  it("rewinds the cursor when the anchor regresses below it (PXE store rebuilt)", async () => {
    let anchor = 500
    const events: ScannedTransferEvent[] = []
    const h = harness({
      head: 500,
      anchor: () => anchor,
      list: (a, b) =>
        events.filter((e) => e.blockNumber >= a && e.blockNumber < b && e.blockNumber <= anchor),
    })
    await h.scanner.start(h.ctx)
    expect(await h.cursor()).toBe(500)

    // PXE store wiped: the anchor regresses far below the cursor. Without the rewind, blocks below
    // cursor minus the margin would never be listed again once PXE re-syncs.
    anchor = 0
    await h.scanner.tickNow()
    expect(await h.cursor()).toBe(0)

    // PXE re-syncs and re-decrypts a transfer the old cursor had already passed.
    events.push(event({ blockNumber: 100 }))
    anchor = 500
    await h.scanner.tickNow()
    expect(h.adds).toHaveLength(1)
    expect(await h.cursor()).toBe(500)
    h.scanner.stop()
  })

  it("rewinds the cursor when head regresses below it", async () => {
    let head = 5000
    const h = harness({ events: [], head: () => head })
    await h.scanner.start(h.ctx)
    expect(h.listIncoming).toHaveBeenLastCalledWith(1, 5001)

    // A rebuild deeper than the reorg margin: without the rewind, `from` would stay at
    // 5000 - margin and the surviving blocks below it would never be rescanned.
    head = 4800
    await h.scanner.tickNow()
    await h.scanner.tickNow()
    expect(h.listIncoming).toHaveBeenLastCalledWith(4800 - TRANSFER_SCAN_REORG_MARGIN, 4801)
    h.scanner.stop()
  })

  it("an explicit tick waits for the in-flight tick, then runs one shared full pass", async () => {
    let release: () => void = () => {}
    let gate: Promise<void> | null = new Promise((r) => (release = r))
    const h = harness({
      events: [],
      list: () => [],
    })
    h.listIncoming.mockImplementation(async () => {
      if (gate) await gate
      return []
    })
    const started = h.scanner.start(h.ctx)
    await new Promise((r) => setTimeout(r, 0))
    // The start tick is parked inside listIncoming; two explicit ticks queue behind it.
    const a = h.scanner.tickNow()
    const b = h.scanner.tickNow()
    let settled = 0
    void a.then(() => settled++)
    void b.then(() => settled++)
    await new Promise((r) => setTimeout(r, 0))
    expect(settled).toBe(0)
    expect(h.listIncoming.mock.calls.length).toBe(1)

    gate = null
    release()
    await Promise.all([started, a, b])
    expect(settled).toBe(2)
    // One pass for the parked start tick, one shared pass for both explicit callers.
    expect(h.listIncoming.mock.calls.length).toBe(2)
    h.scanner.stop()
  })

  it("skips the sync-triggering scan while head is static, but never on an explicit tick", async () => {
    const h = harness({ events: [] })
    await h.scanner.start(h.ctx)
    const afterStart = h.listIncoming.mock.calls.length

    // Background timer with an unchanged head: no PXE sync.
    await h.scheduler.advance(5_000)
    expect(h.listIncoming.mock.calls.length).toBe(afterStart)

    // Pull-to-refresh must still rescan the reorg margin.
    await h.scanner.tickNow()
    expect(h.listIncoming.mock.calls.length).toBe(afterStart + 1)
    h.scanner.stop()
  })

  it("runs onSynced with the anchor after a tick that listed events, never on an idle tick", async () => {
    const settle = () => new Promise((r) => setTimeout(r, 0))
    const synced: number[] = []
    const h = harness({ events: [], head: 100, onSynced: async (a) => void synced.push(a) })
    await h.scanner.start(h.ctx)
    expect(synced).toEqual([100])

    await h.scheduler.advance(5_000) // static head: no sync, no hook
    await settle()
    expect(synced).toEqual([100])

    await h.scanner.tickNow()
    expect(synced).toEqual([100, 100])
    h.scanner.stop()

    // The hook gets the PXE anchor the events were read at, not head.
    const lagging = harness({
      events: [],
      head: 100,
      anchor: () => 90,
      onSynced: async (a) => void synced.push(a),
    })
    await lagging.scanner.start(lagging.ctx)
    expect(synced.at(-1)).toBe(90)
    lagging.scanner.stop()
  })

  it("a throwing onSynced fails the tick and forces a full pass next time", async () => {
    const settle = () => new Promise((r) => setTimeout(r, 0))
    let fail = true
    const synced: number[] = []
    const h = harness({
      events: [],
      head: 100,
      onSynced: async (a) => {
        synced.push(a)
        if (fail) throw new Error("balance read failed")
      },
    })
    await h.scanner.start(h.ctx)
    await settle()
    expect(synced).toEqual([100])
    const listed = h.listIncoming.mock.calls.length

    fail = false
    await h.scheduler.advance(10_000) // backed-off retry with the same head still rescans
    await settle()
    expect(h.listIncoming.mock.calls.length).toBe(listed + 1)
    expect(synced).toEqual([100, 100])
    h.scanner.stop()
  })

  it("stamps rows with the scan context's networkId", async () => {
    const h = harness({ events: [event()] })
    await h.scanner.start(h.ctx)
    expect(h.adds[0]!.networkId).toBe("net")
    h.scanner.stop()
  })

  it("reschedules after a restart with a new context object mid-tick", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const h = harness({ events: [] })
    const slowSource = h.scanner as unknown as {
      opts: { source: { listIncoming: (a: number, b: number) => Promise<ScannedTransferEvent[]> } }
    }
    slowSource.opts.source.listIncoming = async () => {
      await gate
      return []
    }
    const first = h.scanner.start(h.ctx)
    // Restart with a FRESH context object while the first tick is still awaiting the source.
    h.scanner.stop()
    const second = h.scanner.start({ ...h.ctx })
    release()
    await Promise.all([first, second])
    // The finishing stale tick must still schedule the next one for the new context.
    expect(h.scheduler.pendingCount()).toBe(1)
    await h.scheduler.advance(5_000)
    h.scanner.stop()
  })

  it("times out a hung source call instead of wedging the tick latch", async () => {
    const h = harness({ events: [] })
    const hung = h.scanner as unknown as {
      opts: { source: { headBlock: () => Promise<number> } }
      sourceTimeoutMs: number
    }
    Object.defineProperty(hung, "sourceTimeoutMs", { value: 20 })
    hung.opts.source.headBlock = () => new Promise<number>(() => {})
    await h.scanner.start(h.ctx) // resolves via the timeout rejection
    // The latch cleared and the next tick was scheduled — the scanner is not wedged.
    expect(h.scheduler.pendingCount()).toBe(1)
    h.scanner.stop()
  })

  it("scans history in bounded chunks and persists the cursor per completed chunk", async () => {
    const calls: Array<[number, number]> = []
    const h = harness({ head: 25_000, events: [] })
    const src = h.scanner as unknown as {
      opts: { source: { listIncoming: (a: number, b: number) => Promise<ScannedTransferEvent[]> } }
    }
    src.opts.source.listIncoming = async (a, b) => {
      calls.push([a, b])
      return []
    }
    await h.scanner.start(h.ctx)
    expect(calls).toEqual([
      [1, 10_001],
      [10_001, 20_001],
      [20_001, 25_001],
    ])
    h.scanner.stop()
  })

  it("syncs a snapshot pass on its first chunk only", async () => {
    const h = harness({ head: 25_000, events: [] })
    const readSnapshot = vi.fn(async () => ({ events: [], balance: 1n, anchorBlock: 25_000 }))
    const src = h.scanner as unknown as { opts: { source: Record<string, unknown> } }
    src.opts.source.readSnapshot = readSnapshot
    await h.scanner.start(h.ctx)
    expect(readSnapshot.mock.calls).toEqual([
      [1, 10_001, undefined],
      [10_001, 20_001, { assumeSynced: true }],
      [20_001, 25_001, { assumeSynced: true }],
    ])
    await h.scanner.tickNow()
    expect(readSnapshot.mock.calls[3][2]).toBeUndefined()
    h.scanner.stop()
  })

  it("keeps completed-chunk progress when a later chunk fails", async () => {
    const h = harness({
      head: 15_000,
      resolve: async () => {
        throw new Error("registry down")
      },
    })
    const src = h.scanner as unknown as {
      opts: { source: { listIncoming: (a: number, b: number) => Promise<ScannedTransferEvent[]> } }
    }
    const calls: Array<[number, number]> = []
    // Chunk 1 is clean; chunk 2 carries an event whose ingest fails (registry down).
    src.opts.source.listIncoming = async (a, b) => {
      calls.push([a, b])
      return a > 10_000 ? [event({ blockNumber: 10_500 })] : []
    }
    await h.scanner.start(h.ctx)
    expect(h.adds).toHaveLength(0)
    calls.length = 0
    await h.scanner.tickNow()
    // Resumes from the persisted chunk-1 cursor (minus the reorg margin), not from block 1.
    expect(calls[0]![0]).toBe(10_000 - TRANSFER_SCAN_REORG_MARGIN)
    h.scanner.stop()
  })

  it("backs off after consecutive failed ticks and recovers on success", async () => {
    let failing = true
    let ticks = 0
    const h = harness({ events: [] })
    const src = h.scanner as unknown as {
      opts: { source: { headBlock: () => Promise<number> } }
    }
    src.opts.source.headBlock = async () => {
      ticks++
      if (failing) throw new Error("node down")
      return 100
    }
    // The source-timeout wrapper adds real-timer microtask hops, so let each tick fully settle
    // (reschedule registered) before moving the fake clock again.
    const settle = () => new Promise((r) => setTimeout(r, 0))
    await h.scanner.start(h.ctx) // failure #1 -> next delay 10s
    await settle()
    expect(ticks).toBe(1)
    await h.scheduler.advance(5_000)
    await settle()
    // Not yet due: the failed tick doubled the delay.
    expect(ticks).toBe(1)
    await h.scheduler.advance(5_000) // fires; failure #2 -> next delay 20s
    await settle()
    expect(ticks).toBe(2)
    failing = false
    await h.scheduler.advance(20_000) // fires; success resets the delay
    await settle()
    expect(ticks).toBe(3)
    await h.scheduler.advance(5_000)
    await settle()
    expect(ticks).toBe(4)
    h.scanner.stop()
  })

  it("rescans the reorg margin without double-inserting", async () => {
    const h = harness({ events: [event()] })
    await h.scanner.start(h.ctx)
    await h.scanner.tickNow()
    await h.scanner.tickNow()
    expect(h.adds).toHaveLength(1)
    expect(h.scheduler.pendingCount()).toBe(1)
    h.scanner.stop()
    expect(h.scheduler.pendingCount()).toBe(0)
  })
})

describe("TransferEventScanner cursor scope", () => {
  const UNSCOPED_KEY = `@obsidion/transfer-scan/cursor/v1/net/${ME}`
  const SCOPED_KEY = `@obsidion/transfer-scan/cursor/v1/net/A/${ME}`
  const cursorKeys = (calls: unknown[][]) =>
    calls.map(([k]) => k as string).filter((k) => k.startsWith("@obsidion/transfer-scan/cursor/"))

  it("keeps the cursor under the scoped key and never touches the unscoped one", async () => {
    const h = harness({ events: [] })
    const getItem = vi.spyOn(h.storage, "getItem")
    const setItem = vi.spyOn(h.storage, "setItem")
    await h.scanner.start({ ...h.ctx, endpointScope: "A" })
    await h.scanner.tickNow()
    h.scanner.stop()
    const keys = cursorKeys([...getItem.mock.calls, ...setItem.mock.calls])
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.filter((k) => k !== SCOPED_KEY)).toEqual([])
    expect(await h.storage.getItem(SCOPED_KEY)).toBe("100")
    expect(await h.storage.getItem(UNSCOPED_KEY)).toBeNull()
  })

  it("uses the unscoped key without a scope", async () => {
    const h = harness({ events: [] })
    const setItem = vi.spyOn(h.storage, "setItem")
    await h.scanner.start(h.ctx)
    h.scanner.stop()
    expect(cursorKeys(setItem.mock.calls)).toEqual([UNSCOPED_KEY])
    expect(await h.storage.getItem(UNSCOPED_KEY)).toBe("100")
  })

  it("a scoped scan advances its own cursor; the unscoped scan resumes from its older one", async () => {
    let head = 1_000
    const h = harness({ events: [], head: () => head })
    await h.scanner.start(h.ctx)
    expect(h.listIncoming).toHaveBeenLastCalledWith(1, 1_001)
    h.scanner.stop()

    head = 5_000
    await h.scanner.start({ ...h.ctx, endpointScope: "A" })
    expect(h.listIncoming).toHaveBeenLastCalledWith(1, 5_001) // cursorless under A
    expect(await h.storage.getItem(SCOPED_KEY)).toBe("5000")
    expect(await h.storage.getItem(UNSCOPED_KEY)).toBe("1000")
    h.scanner.stop()

    await h.scanner.start(h.ctx)
    expect(h.listIncoming).toHaveBeenLastCalledWith(1_000 - TRANSFER_SCAN_REORG_MARGIN, 5_001)
    expect(await h.storage.getItem(UNSCOPED_KEY)).toBe("5000")
    expect(await h.storage.getItem(SCOPED_KEY)).toBe("5000")
    h.scanner.stop()
  })
})
