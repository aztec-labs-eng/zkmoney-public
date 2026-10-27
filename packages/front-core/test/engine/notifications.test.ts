import { describe, expect, it } from "vitest"
import { demotePaylinkClaim } from "../../src/core/services/paylink/PaylinkClaimReconciler"
import { createActivity } from "../../src/engine/activity"
import { createMemoryKv, type KvStore } from "../../src/engine/kv"
import {
  selectNotifications,
  watchNotifications,
  type NotificationSources,
} from "../../src/engine/notificationFeed"
import {
  createNotifications,
  NOTIFICATION_LIMIT,
  NOTIFICATION_WINDOW_MS,
  notificationTransition,
  type NotificationChange,
  type NotificationEvent,
  type NotificationRecord,
  type NotificationState,
} from "../../src/engine/notifications"
import { APP_NOTIFICATION_STORAGE_KEY } from "../../src/engine/notificationsLegacy"
import { memoryStore, derived } from "../../src/engine/store"
import type { Transaction } from "../../src/types/transactions"
import { diskKv } from "./diskKv"

const NOW = 1_800_000_000_000
const OLD = NOW - NOTIFICATION_WINDOW_MS - 1

const contact = (address: string, at = NOW): NotificationEvent => ({
  id: `contact:added:${address}`,
  at,
  kind: "contactAdded",
  data: { address, contactId: address },
})
const residuals = (count: number, at = NOW): NotificationEvent => ({
  id: "migration:residuals",
  at,
  kind: "migrationResiduals",
  data: { items: [{ kind: "transit", count }] },
})

const reclaimable = (at = NOW): NotificationEvent => ({
  id: "paylink:reclaimable:0xp",
  at,
  kind: "reclaimable",
  data: { txHash: "0xP" },
})

describe("notificationTransition", () => {
  const id = "migration:residuals"
  const row = (over: Partial<NotificationState> = {}) => ({ id, firstSeenAt: NOW, ...over })
  const records: Record<string, NotificationRecord> = {
    "none": { id },
    "unread": { id, state: row() },
    "read": { id, state: row({ readAt: NOW }) },
    "dismissed": { id, state: row({ readAt: NOW, dismissedAt: NOW }) },
    "fact": { id, event: residuals(1) },
    "unread fact": { id, state: row(), event: residuals(1) },
    "dismissed fact": { id, state: row({ readAt: NOW, dismissedAt: NOW }), event: residuals(1) },
  }
  const changes: Record<string, NotificationChange> = {
    "listed": { type: "listed", at: NOW, old: false },
    "listed old": { type: "listed", at: NOW, old: true },
    "read": { type: "read", at: NOW },
    "dismissed": { type: "dismissed", at: NOW },
    "recorded same": { type: "recorded", event: residuals(1, NOW + 1) },
    "recorded other": { type: "recorded", event: residuals(2, NOW + 1) },
    "reported same": { type: "reported", event: residuals(1, NOW + 1) },
    "reported other": { type: "reported", event: residuals(2, NOW + 1) },
    "retracted": { type: "retracted" },
    "retired listed": { type: "retired", listed: true },
    "retired": { type: "retired", listed: false },
    "capped listed": { type: "capped", listed: true },
    "capped": { type: "capped", listed: false },
  }
  // State: U unread, R read, D dismissed, _ none. Event: its count, _ none. "=" leaves it.
  const expected: Record<string, string[]> = {
    // none, unread, read, dismissed, fact, unread fact, dismissed fact
    "listed": ["U_", "=", "=", "=", "U1", "=", "="],
    "listed old": ["=", "=", "=", "=", "=", "=", "="],
    "read": ["=", "R_", "=", "=", "=", "R1", "="],
    "dismissed": ["=", "D_", "D_", "=", "=", "D1", "="],
    "recorded same": ["U1", "U1", "R1", "D1", "=", "=", "="],
    "recorded other": ["U2", "U2", "R2", "D2", "=", "=", "="],
    "reported same": ["U1", "U1", "R1", "R1", "=", "=", "="],
    "reported other": ["U2", "U2", "R2", "R2", "_2", "U2", "R2"],
    "retracted": ["=", "__", "__", "__", "__", "__", "__"],
    "retired listed": ["=", "=", "=", "=", "=", "=", "="],
    "retired": ["=", "__", "__", "__", "=", "__", "__"],
    "capped listed": ["=", "=", "=", "=", "=", "=", "="],
    "capped": ["=", "=", "__", "__", "=", "=", "__"],
  }
  const summary = (r: NotificationRecord | undefined) => {
    if (!r) return "="
    const { state, event } = r
    const s = !state ? "_" : state.dismissedAt ? "D" : state.readAt ? "R" : "U"
    const e =
      event?.kind === "migrationResiduals" ? (event.data.items[0] as { count: number }).count : "_"
    return `${s}${e}`
  }
  for (const [changeName, change] of Object.entries(changes)) {
    Object.entries(records).forEach(([recordName, record], i) => {
      it(`${changeName} on ${recordName}`, () => {
        expect(summary(notificationTransition(record, change))).toBe(expected[changeName][i])
      })
    })
  }

  it("dates a fact reaching a row carried over without one by the row", () => {
    const next = notificationTransition(records.read, changes["reported other"])
    expect(next?.event?.at).toBe(NOW)
  })
})

describe("the firstSeenAt writer", () => {
  it("stamps an entry first seen within its window, and never one that settled before", async () => {
    const n = createNotifications(createMemoryKv())
    await n.observe(
      [{ id: "a", settledAt: NOW - 1000 }, { id: "b", settledAt: OLD }, { id: "c" }],
      [],
      NOW,
      true,
    )
    expect([...n.state.get().keys()]).toEqual(["a", "c"])
    expect(n.state.get().get("a")).toEqual({ id: "a", firstSeenAt: NOW })
    await n.observe([{ id: "a", settledAt: NOW - 1000 }], [], NOW + 5, true)
    expect(n.state.get().get("a")?.firstSeenAt).toBe(NOW)
  })

  it("stamps an old ending whose live row it saw", async () => {
    const n = createNotifications(createMemoryKv())
    await n.observe([{ id: "live", pending: true }], [], NOW, true)
    await n.observe([{ id: "done", settledAt: OLD, seenWith: "live" }], [], NOW, true)
    expect(n.state.get().has("done")).toBe(true)
  })

  it("forgets a retired id, unless it is listed again", async () => {
    const n = createNotifications(createMemoryKv())
    await n.observe([{ id: "failed" }, { id: "kept" }], [], NOW, true)
    await n.observe([{ id: "kept" }], ["failed", "kept"], NOW, true)
    expect([...n.state.get().keys()]).toEqual(["kept"])
  })
})

describe("the limit", () => {
  const entries = (count: number, from = 0) =>
    Array.from({ length: count }, (_, i) => ({ id: `e${from + i}` }))
  /** `count` read rows, the oldest first. */
  const filled = async (count: number) => {
    const n = createNotifications(createMemoryKv())
    for (const [i, entry] of entries(count).entries()) await n.observe([entry], [], NOW + i, true)
    await n.markRead(entries(count).map((e) => e.id))
    return n
  }

  it("drops the oldest read rows nothing lists, never unread ones", async () => {
    const n = await filled(NOTIFICATION_LIMIT + 3)
    await n.observe([{ id: "fresh" }], [], NOW, true)
    expect(n.state.get().size).toBe(NOTIFICATION_LIMIT)
    for (const id of ["e0", "e1", "e2", "e3"]) expect(n.state.get().has(id)).toBe(false)
    expect(n.state.get().get("fresh")?.readAt).toBeUndefined()
  })

  it("never drops a listed id, so a listed entry never rings twice", async () => {
    const n = await filled(NOTIFICATION_LIMIT + 3)
    const listed = entries(NOTIFICATION_LIMIT + 3)
    await n.observe(listed, [], NOW + 1000, true)
    expect(n.state.get().size).toBe(NOTIFICATION_LIMIT + 3)
    await n.observe(listed, [], NOW + 2000, true)
    expect([...n.state.get().values()].filter((row) => row.readAt === undefined)).toEqual([])
  })

  it("drops nothing until every source has loaded", async () => {
    const n = await filled(NOTIFICATION_LIMIT + 3)
    await n.observe([], [], NOW, false)
    expect(n.state.get().size).toBe(NOTIFICATION_LIMIT + 3)
  })

  it("keeps a read fact past the limit, so recording it again does not ring", async () => {
    const n = createNotifications(createMemoryKv())
    await n.record(reclaimable(NOW - 10))
    await n.observe([{ id: reclaimable().id }], [], NOW - 10, true)
    await n.markRead([reclaimable().id])
    const listed = [{ id: reclaimable().id }, ...entries(NOTIFICATION_LIMIT + 3)]
    await n.observe(listed, [], NOW, true)
    await n.markRead(listed.map((e) => e.id))
    await n.observe(listed, [], NOW + 1, true)
    expect(n.has(reclaimable().id)).toBe(true)
    await n.record(reclaimable(NOW + 2))
    await n.observe(listed, [], NOW + 2, true)
    expect(n.state.get().get(reclaimable().id)?.readAt).toBeDefined()
    expect(n.events.get().get(reclaimable().id)?.at).toBe(NOW - 10)
  })
})

describe("read and dismissed", () => {
  it("marks read once, and a dismissal reads it too", async () => {
    const n = createNotifications(createMemoryKv())
    await n.observe([{ id: "a" }, { id: "b" }], [], NOW, true)
    await n.markRead(["a"], NOW + 1)
    await n.markRead(["a"], NOW + 2)
    await n.dismiss(["b"], NOW + 3)
    expect(n.state.get().get("a")).toMatchObject({ readAt: NOW + 1 })
    expect(n.state.get().get("b")).toMatchObject({ readAt: NOW + 3, dismissedAt: NOW + 3 })
  })
})

describe("events", () => {
  it("records a fact once", async () => {
    const n = createNotifications(createMemoryKv())
    await n.record(contact("0xa", NOW))
    await n.record(contact("0xa", NOW + 9))
    expect(n.events.get().get("contact:added:0xa")?.at).toBe(NOW)
  })

  it("keeps an unchanged report's time and dismissal, and brings a changed one back, read", async () => {
    const n = createNotifications(createMemoryKv())
    await n.report(residuals(2, NOW))
    await n.observe([{ id: "migration:residuals" }], [], NOW, true)
    await n.dismiss(["migration:residuals"], NOW + 1)
    await n.report(residuals(2, NOW + 2))
    expect(n.events.get().get("migration:residuals")?.at).toBe(NOW)
    expect(n.state.get().get("migration:residuals")?.dismissedAt).toBe(NOW + 1)
    await n.report(residuals(3, NOW + 3))
    expect(n.events.get().get("migration:residuals")?.at).toBe(NOW + 3)
    expect(n.state.get().get("migration:residuals")).toMatchObject({ readAt: NOW + 1 })
    expect(n.state.get().get("migration:residuals")?.dismissedAt).toBeUndefined()
  })

  it("forgets a retracted one, so its next report rings anew", async () => {
    const n = createNotifications(createMemoryKv())
    await n.report(residuals(1))
    await n.observe([{ id: "migration:residuals" }], [], NOW, true)
    await n.retract("migration:residuals")
    expect(n.has("migration:residuals")).toBe(false)
  })

  it("persist across a reopen", async () => {
    const kv = createMemoryKv()
    const n = createNotifications(kv)
    await n.ready
    await n.record(contact("0xa"))
    await n.observe([{ id: "contact:added:0xa" }], [], NOW, true)
    const again = createNotifications(kv)
    expect(again.events.get().get("contact:added:0xa")).toEqual(contact("0xa"))
    expect(again.state.get().get("contact:added:0xa")).toEqual({
      id: "contact:added:0xa",
      firstSeenAt: NOW,
    })
  })
})

describe("saving", () => {
  it("saves a report's event and its state row in one transaction", async () => {
    const disk = diskKv()
    const n = createNotifications(disk.kv)
    await n.ready
    await n.report(residuals(1))
    await n.observe([{ id: "migration:residuals" }], [], NOW, true)
    await n.dismiss(["migration:residuals"], NOW + 1)
    const writes: (readonly (readonly [string, string | null])[])[] = []
    disk.kv.onCommit((ops) => writes.push(ops))
    await n.report(residuals(2))
    expect(writes).toHaveLength(1)
    expect(writes[0].map(([key]) => key).sort()).toEqual([
      "acct/notificationEvents/migration:residuals",
      "acct/notificationState/migration:residuals",
    ])
  })

  it("shows nothing of a failed save, so a fire-once fact is recorded again", async () => {
    const disk = diskKv()
    const n = createNotifications(disk.kv)
    await n.ready
    disk.fail(true)
    await expect(n.record(reclaimable())).rejects.toThrow("disk")
    expect(n.has(reclaimable().id)).toBe(false)
    disk.fail(false)
    await n.record(reclaimable())
    expect(createNotifications(disk.kv).has(reclaimable().id)).toBe(true)
  })

  it("leaves no row behind a fact whose save failed, so a retry records it", async () => {
    const disk = diskKv()
    const n = createNotifications(disk.kv)
    await n.ready
    const sources = memoryStore<NotificationSources>({
      rows: [],
      deposits: { records: [], hydrated: true },
      withdrawals: { records: [], hydrated: true },
      upgrades: { items: [], recipients: new Set<string>(), loaded: true },
      oldVersionWithdrawals: [],
      processing: new Map(),
      registrations: [],
      operations: { ended: [], running: [] },
      loaded: true,
    })
    const stop = watchNotifications(sources.readonly, memoryStore(NOW).readonly, n)
    disk.fail(true)
    await expect(n.record(reclaimable())).rejects.toThrow("disk")
    disk.fail(false)
    await n.observe([], [], NOW, true)
    expect(n.has(reclaimable().id)).toBe(false)
    expect(n.state.get().has(reclaimable().id)).toBe(false)
    expect(createNotifications(disk.kv).state.get().has(reclaimable().id)).toBe(false)
    await n.record(reclaimable())
    const reopened = createNotifications(disk.kv)
    expect(reopened.has(reclaimable().id)).toBe(true)
    expect(reopened.state.get().has(reclaimable().id)).toBe(true)
    stop()
  })

  it("keeps no row a failed pass stamped", async () => {
    const disk = diskKv()
    const n = createNotifications(disk.kv)
    await n.ready
    disk.fail(true)
    await expect(n.observe([{ id: "a" }, { id: "b" }], [], NOW, true)).rejects.toThrow()
    expect(n.state.get().size).toBe(0)
    disk.fail(false)
    await n.observe([{ id: "a" }, { id: "b" }], [], NOW, true)
    expect(n.state.get().size).toBe(2)
  })
})

describe("the legacy bell", () => {
  const legacy = (entries: Record<string, unknown>[]): KvStore => {
    const kv = createMemoryKv()
    kv.setItem(
      APP_NOTIFICATION_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(entries.map((e) => [e.id, e]))),
    )
    return kv
  }
  const entry = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    title: "",
    description: "",
    timestampMs: NOW,
    read: false,
    target: { type: "x" },
    ...over,
  })

  it("brings a dismissed old-funds notice back on its first report; a recorded fact stays dismissed", async () => {
    const reorg = "reorg:failed:0xr"
    const n = createNotifications(
      legacy([
        entry("migration:residuals", { read: true, dismissedAt: NOW + 1 }),
        entry(reorg, { read: true, dismissedAt: NOW + 1 }),
      ]),
    )
    await n.ready
    await n.report(residuals(1, NOW + 5))
    expect(n.state.get().get("migration:residuals")).toEqual({
      id: "migration:residuals",
      firstSeenAt: NOW,
      readAt: NOW,
    })
    await n.record({
      id: reorg,
      at: NOW + 5,
      kind: "reorg",
      data: { outcome: "failed", txHash: "0xr" },
    })
    expect(n.state.get().get(reorg)?.dismissedAt).toBe(NOW + 1)
  })

  it("carries every entry's state, and keeps the legacy key", () => {
    const kv = legacy([
      entry("transfer:receive:0x1", { read: true, readAt: NOW + 1 }),
      entry("bridge:withdrawal:w:done", { read: true, dismissedAt: NOW + 2 }),
      entry("registration:a:b"),
    ])
    const n = createNotifications(kv)
    expect([...n.state.get().values()]).toEqual([
      { id: "transfer:receive:0x1", firstSeenAt: NOW, readAt: NOW + 1 },
      { id: "bridge:withdrawal:w:done", firstSeenAt: NOW, readAt: NOW, dismissedAt: NOW + 2 },
      { id: "registration:a:b", firstSeenAt: NOW },
    ])
    expect(n.events.get().size).toBe(0)
    expect(kv.getItem(APP_NOTIFICATION_STORAGE_KEY)).not.toBeNull()
  })

  it("rebuilds the facts no record holds from their ids and targets", () => {
    const n = createNotifications(
      legacy([
        entry("reorg:failed:0xab:1", {
          description: "This payment to you was reverted by the network and did not complete",
          target: { type: "reorg.txDetail", txHash: "0xAB" },
        }),
        entry("reorg:reconfirmed:0xab:1", { title: "Withdrawal resumed" }),
        entry("contact:added:0xc", { target: { type: "contact.added", contactId: "bo" } }),
        entry("paylink:claim-reversed:0xp", { target: { type: "paylink.claimed", txHash: "0xP" } }),
        entry("paylink:reclaimable:0xp", {
          target: { type: "paylink.reclaimable", txHash: "0xP" },
        }),
        entry("migration:run", { description: "Your upgrade is paused. Open it to continue." }),
      ]),
    )
    const data = Object.fromEntries([...n.events.get()].map(([id, e]) => [id, e.data]))
    expect(data).toEqual({
      "reorg:failed:0xab:1": { outcome: "failed", txHash: "0xAB", incoming: true },
      "reorg:reconfirmed:0xab:1": { outcome: "reconfirmed", txHash: "0xab", withdrawal: true },
      "contact:added:0xc": { address: "0xc", contactId: "bo", tag: "bo" },
      "paylink:claim-reversed:0xp": { txHash: "0xP" },
      "paylink:reclaimable:0xp": { txHash: "0xP" },
      "migration:run": { stop: "paused" },
    })
  })

  it("keeps state only where the facts cannot be rebuilt", () => {
    const n = createNotifications(
      legacy([entry("migration:residuals"), entry("reorg:failed:0xab:1", { description: "?" })]),
    )
    expect(n.events.get().size).toBe(0)
    expect(n.state.get().size).toBe(2)
  })

  it("reads nothing from a blob it cannot parse", () => {
    const kv = createMemoryKv()
    kv.setItem(APP_NOTIFICATION_STORAGE_KEY, "{")
    expect(createNotifications(kv).state.get().size).toBe(0)
  })
})

describe("watchNotifications", () => {
  it("stamps entries as the records and facts change, until unsubscribed", async () => {
    const n = createNotifications(createMemoryKv())
    const receive = (hash: string) =>
      ({
        id: hash,
        action: "receive",
        txHash: hash,
        timestamp: Date.now(),
        amountAtomic: 0n,
      } as Transaction)
    const none = { records: [], hydrated: true }
    const sources = memoryStore<NotificationSources>({
      rows: [receive("0xa")],
      deposits: none,
      withdrawals: none,
      upgrades: { items: [], recipients: new Set<string>(), loaded: true },
      oldVersionWithdrawals: [],
      processing: new Map(),
      registrations: [],
      operations: { ended: [], running: [] },
      loaded: true,
    })
    const clock = memoryStore(Date.now())
    const stop = watchNotifications(sources.readonly, clock.readonly, n)
    expect(n.state.get().has("transfer:receive:0xa")).toBe(true)
    sources.update((s) => ({ ...s, rows: [...s.rows, receive("0xb")] }))
    expect(n.state.get().has("transfer:receive:0xb")).toBe(true)
    // The writer stamps a recorded fact from inside the record's own change.
    await n.record(contact("0xd"))
    expect(n.state.get().has("contact:added:0xd")).toBe(true)
    stop()
    sources.update((s) => ({ ...s, rows: [...s.rows, receive("0xc")] }))
    expect(n.state.get().has("transfer:receive:0xc")).toBe(false)
  })

  const quiet = (rows: readonly Transaction[]): NotificationSources => ({
    rows,
    deposits: { records: [], hydrated: true },
    withdrawals: { records: [], hydrated: true },
    upgrades: { items: [], recipients: new Set<string>(), loaded: true },
    oldVersionWithdrawals: [],
    processing: new Map(),
    registrations: [],
    operations: { ended: [], running: [] },
    loaded: true,
  })
  const token = {
    address: "0xt",
    name: "D",
    symbol: "D",
    decimals: 6,
    logo: "",
    amount: 1,
    price: 1,
  }

  it("stamps a receive only once its row is saved, and the retry that lands stamps it", async () => {
    const disk = diskKv()
    const activity = createActivity({ kv: disk.kv, networkId: () => "net" })
    await activity.ready
    const n = createNotifications(createMemoryKv())
    const sources = derived([activity.rows], quiet)
    const stop = watchNotifications(sources, memoryStore(Date.now()).readonly, n)
    const scan = () =>
      disk.kv.batch(() =>
        activity.upsertScanned({
          txHash: "0xa",
          from: "alice",
          senderL2Address: "0xalice",
          to: "me",
          token,
          amountAtomic: 1n,
          timestamp: Date.now(),
        }),
      )
    disk.fail(true)
    await expect(scan()).rejects.toThrow("disk")
    expect(n.state.get().size).toBe(0)
    disk.fail(false)
    await scan()
    const listed = selectNotifications(sources.get(), n.state.get(), n.events.get(), Date.now())
    expect(listed.map(({ id, read }) => ({ id, read }))).toEqual([
      { id: "transfer:receive:0xa", read: false },
    ])
    stop()
  })

  it("reports a claim reversal only once the demote is saved, and only once", async () => {
    const disk = diskKv()
    const activity = createActivity({ kv: disk.kv, networkId: () => "net" })
    activity.addRecoveredPaylink({
      txHash: "0xp",
      flavor: "direct",
      token,
      amountAtomic: 1n,
      timestamp: Date.now(),
      blockNumber: 1,
      payToEmailSecret: "s",
      obsidionAccountAddress: "0xme",
      tokenAddress: "0xt",
      paylink: "url",
      fallbackSecret: "f",
      networkId: "net",
      isClaimed: true,
    })
    await disk.land()
    const n = createNotifications(createMemoryKv())
    const stop = watchNotifications(
      derived([activity.rows], quiet),
      memoryStore(Date.now()).readonly,
      n,
    )
    expect(n.state.get().has("paylink:claimed:0xp")).toBe(true)
    const reversal = "paylink:claim-reversed:0xp"
    disk.hold(true)
    disk.fail(true)
    expect(demotePaylinkClaim("0xp", activity)).toBe(true)
    await disk.land()
    expect(n.events.get().has(reversal)).toBe(false)
    disk.fail(false)
    expect(demotePaylinkClaim("0xp", activity)).toBe(true)
    await disk.land()
    expect(n.events.get().get(reversal)).toMatchObject({
      kind: "claimReversed",
      data: { txHash: "0xp" },
    })
    await n.dismiss([reversal])
    expect(n.events.get().has(reversal)).toBe(true)
    expect(n.state.get().get(reversal)?.dismissedAt).toBeDefined()
    stop()
  })
})
