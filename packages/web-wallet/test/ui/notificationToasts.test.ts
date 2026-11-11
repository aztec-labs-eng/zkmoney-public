// @vitest-environment node
/** The bell toasts an outcome once: never a live row, a read entry, or the backlog behind it. */
import {
  notificationsStamped,
  selectNotifications,
  type NotificationEntry,
  type NotificationSources,
  type NotificationState,
  type SipaDeposit,
  type Transaction,
  type UpgradeBatchItem,
  type UpgradePricing,
} from "@obsidion/front-core"
import { describe, expect, it } from "vitest"
import {
  freshToasts,
  nextToasts,
  toastKey,
  type Toasts,
} from "../../src/ui/NotificationsPanel/NotificationsPanel"

const entry = (patch: Partial<NotificationEntry>): NotificationEntry => ({
  id: "contact:added:0x1",
  about: {
    kind: "event",
    event: {
      id: "contact:added:0x1",
      at: 1,
      kind: "contactAdded",
      data: { address: "0x1", contactId: "0x1" },
    },
  },
  timestampMs: 1,
  severity: "success",
  icon: "",
  pending: false,
  read: false,
  firstSeenAt: 10,
  target: { type: "contact.added", contactId: "0x1" },
  ...patch,
})

describe("freshToasts", () => {
  it("never toasts a live row", () => {
    expect(freshToasts([entry({ pending: true })], new Set(), 0)).toEqual([])
  })

  it("toasts the outcome of a row it watched in flight", () => {
    const seen = new Set([toastKey(entry({ pending: true }))])
    expect(freshToasts([entry({})], seen, 0)).toHaveLength(1)
  })

  it("toasts a settled entry once, never one already read or first seen before the bell", () => {
    expect(freshToasts([entry({})], new Set([toastKey(entry({}))]), 0)).toEqual([])
    expect(freshToasts([entry({ read: true })], new Set(), 0)).toEqual([])
    expect(freshToasts([entry({})], new Set(), 11)).toEqual([])
  })

  it("toasts once a live row from before the bell that settles while it watches", () => {
    let seen = new Set([toastKey(entry({ pending: true }))])
    const settled = [entry({})]
    expect(freshToasts(settled, seen, 11)).toHaveLength(1)
    seen = new Set(settled.map(toastKey))
    expect(freshToasts(settled, seen, 11)).toEqual([])
    // One already settled when the bell mounted stays history.
    expect(freshToasts(settled, new Set(), 11)).toEqual([])
  })
})

describe("nextToasts", () => {
  const start: Toasts = { seen: null, backlog: new Map(), queue: [], open: false }
  const read = (toasts: Toasts, entries: NotificationEntry[], open = false, hydrated = true) =>
    nextToasts(toasts, { entries, state: new Map(), hydrated, open, since: 0 })
  const a = entry({ id: "a" })
  const b = entry({ id: "b" })

  it("keeps the first hydrated list behind the bell", () => {
    expect(read(read(start, [a], false, false), [a]).queue).toEqual([])
  })

  it("queues an entry first listed after hydration once, and settles on an unchanged list", () => {
    const listed = [a]
    const once = read(read(start, []), listed)
    expect(once.queue).toEqual([a])
    expect(read(once, listed)).toBe(once)
    // A new list with the same entries, as each render may bring.
    expect(read(once, [entry({ id: "a" })])).toBe(once)
  })

  it("empties the queue when the panel opens, and keeps what arrives while it is open", () => {
    const opened = read(read(read(start, []), [a]), [a], true)
    expect(opened.queue).toEqual([])
    expect(read(opened, [a, b], true).queue).toEqual([b])
  })

  it("drops a queued entry that left the list", () => {
    const queued = read(read(start, []), [a, b])
    expect(read(queued, [b]).queue).toEqual([b])
  })
})

describe("the bell's starting list beside an upgrade waiting on its price", () => {
  const NOW = 1_800_000_000_000
  const E18 = 10n ** 18n
  const MAIN = `0x${"da".repeat(20)}`
  const SIPA = `0x${"d1".repeat(20)}`
  const DONE = "migration-run:r1:done:1"
  const RECEIVE = "transfer:receive:0xr1"
  const batch = {
    id: "first",
    run: "r1",
    recipient: SIPA,
    amount: "20",
    exitFee: "0",
    state: "sent",
    approved: true,
    first: true,
    startTime: NOW - 7_200_000,
  } as unknown as UpgradeBatchItem
  const arrival = {
    sipaAddress: SIPA,
    tokenAddress: MAIN,
    phase: "claimed",
    amount: "20",
    netAmount: (20n * E18).toString(),
    fee: "0",
    startTime: NOW - 7_200_000,
    endTime: NOW - 3_600_000,
  } as SipaDeposit
  const receive = {
    id: "0xr1",
    action: "receive",
    amountAtomic: 5n * E18,
    timestamp: NOW,
    status: "success",
    txHash: "0xR1",
  } as Transaction
  const sources = (rows: Transaction[], upgradePricing: UpgradePricing): NotificationSources => ({
    rows,
    links: [],
    oldVersionWithdrawals: [],
    deposits: { records: [arrival], loaded: true, failed: false },
    withdrawals: { records: [], hydrated: true },
    bridgeIns: { records: [], hydrated: true },
    upgrades: { items: [batch], recipients: new Set([SIPA]), loaded: true },
    upgradePricing,
    processing: new Map(),
    registrations: [],
    operations: { ended: [], running: [] },
    loaded: true,
  })
  const rows = (...ids: [string, number][]) =>
    new Map<string, NotificationState>(ids.map(([id, firstSeenAt]) => [id, { id, firstSeenAt }]))
  const bell = (toasts: Toasts, s: NotificationSources, state: Map<string, NotificationState>) =>
    nextToasts(toasts, {
      entries: selectNotifications(s, state, new Map(), NOW),
      state,
      hydrated: notificationsStamped(s, state, new Map(), NOW),
      open: false,
      since: NOW - 1,
    })

  it("toasts a receive that lands while the price is pending, and not the upgrade once priced", () => {
    const pending: UpgradePricing = { settled: false }
    const started = bell(
      { seen: null, backlog: new Map(), queue: [], open: false },
      sources([], pending),
      rows([DONE, NOW]),
    )
    const landed = rows([DONE, NOW], [RECEIVE, NOW + 1])
    const received = bell(started, sources([receive], pending), landed)
    expect(received.queue.map((e) => e.id)).toEqual([RECEIVE])
    const priced = bell(received, sources([receive], { mainToken: MAIN, settled: true }), landed)
    expect(priced.queue.map((e) => e.id)).toEqual([RECEIVE])
  })
})
