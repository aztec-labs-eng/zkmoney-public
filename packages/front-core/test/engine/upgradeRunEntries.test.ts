// The bell's upgrade-run entries: live while the run's batches travel, and complete once every
// batch arrived and the run's dollar value is known, or the pricing settled without one.
import { describe, expect, it } from "vitest"
import type { UpgradeBatchItem } from "../../src/core/migration/upgradeActivity"
import type { UpgradePricing } from "../../src/core/migration/upgradeRuns"
import type { SipaDeposit } from "../../src/engine/sipaDeposits"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import { createNotifications } from "../../src/engine/notifications"
import {
  deriveNotifications,
  notificationsStamped,
  type NotificationSources,
} from "../../src/engine/notificationFeed"

const NOW = 1_800_000_000_000
const HOUR = 3_600_000
const E18 = 10n ** 18n
const addr = (byte: string) => `0x${byte.repeat(20)}`
const MAIN = addr("da")
const PRICED: UpgradePricing = { mainToken: MAIN, settled: true }
const UNPRICED: UpgradePricing = { settled: false }

const deposit = (over: Partial<SipaDeposit> = {}): SipaDeposit =>
  ({
    sipaAddress: addr("d1"),
    tokenAddress: MAIN,
    phase: "claimed",
    amount: "20",
    netAmount: (20n * E18).toString(),
    fee: "0",
    startTime: NOW - 2 * HOUR,
    endTime: NOW - HOUR,
    ...over,
  } as SipaDeposit)

const sources = (over: Partial<NotificationSources> = {}): NotificationSources => ({
  rows: [],
  links: [],
  oldVersionWithdrawals: [],
  deposits: { records: [], loaded: true, failed: false },
  withdrawals: { records: [], hydrated: true },
  bridgeIns: { records: [], hydrated: true },
  upgrades: { items: [], recipients: new Set(), loaded: true },
  upgradePricing: PRICED,
  processing: new Map(),
  registrations: [],
  operations: { ended: [], running: [] },
  loaded: true,
  ...over,
})

const entries = (s: NotificationSources) => deriveNotifications(s, new Map(), NOW)
const ids = (s: NotificationSources) => entries(s).map((e) => e.id)

describe("upgrade-run entries", () => {
  const batch = {
    id: "first",
    run: "r1",
    recipient: addr("d1"),
    amount: "20",
    exitFee: "0",
    state: "sent",
    approved: true,
    first: true,
    startTime: NOW - 2 * HOUR,
  } as unknown as UpgradeBatchItem
  const run = (phase: SipaDeposit["phase"], more: UpgradeBatchItem[] = [], pricing = PRICED) =>
    sources({
      upgrades: { items: [batch, ...more], recipients: new Set([addr("d1")]), loaded: true },
      deposits: { records: [deposit({ phase })], loaded: true, failed: false },
      upgradePricing: pricing,
    })

  it("reports a run live, and complete once every batch arrived, with its value", () => {
    expect(ids(run("sweeping"))).toEqual(["migration-run:r1"])
    const [done] = entries(run("claimed"))
    expect(done?.id).toBe("migration-run:r1:done:1")
    expect(done?.about).toMatchObject({ kind: "upgradeRun", done: true, value: 20n * E18 })
    // Complete only once no other run is approved and unsent.
    const planned = { ...batch, id: "second", run: "r2", state: "planned", first: false }
    expect(ids(run("claimed", [planned as UpgradeBatchItem]))).not.toContain(
      "migration-run:r1:done:1",
    )
  })

  it("holds Upgrade complete until the run's value is known", () => {
    expect(ids(run("claimed", [], UNPRICED))).toEqual([])
    const [live] = entries(run("sweeping", [], UNPRICED))
    expect(live?.about).toMatchObject({ kind: "upgradeRun", done: false, value: undefined })
  })

  it("completes the bell's starting list once a finished run is stamped, before its price", () => {
    const stamped = (ids: string[]) =>
      notificationsStamped(run("claimed", [], UNPRICED), new Map(), new Map(), NOW, new Set(ids))
    expect(stamped([])).toBe(false)
    expect(stamped(["migration-run:r1:done:1"])).toBe(true)
  })

  it("lists a finished run complete to the stamping writer, which reads no pricing", () => {
    const { upgradePricing: _, ...unpriced } = run("claimed", [], UNPRICED)
    const [done] = entries(unpriced)
    expect(done?.id).toBe("migration-run:r1:done:1")
    expect(done?.about).toMatchObject({ kind: "upgradeRun", done: true, value: undefined })
  })

  it("values a Savings run's shares at the share price", () => {
    const savings = { savingsToken: MAIN, sharePrice: 2n * E18, settled: true }
    const [done] = entries(run("claimed", [], savings))
    expect(done?.about).toMatchObject({ value: 40n * E18 })
  })

  it("reports a finished run no settled pricing can value as complete, with no value", () => {
    for (const pricing of [{ settled: true }, { savingsToken: MAIN, settled: true }]) {
      const [done] = entries(run("claimed", [], pricing))
      expect(done?.id).toBe("migration-run:r1:done:1")
      expect(done?.about).toMatchObject({ kind: "upgradeRun", done: true, value: undefined })
    }
  })

  it("saves the rows of a run whose record key holds a '/'", async () => {
    const keyed = {
      ...batch,
      run: `metadata-migration/${addr("c1")}/${addr("c2")}/0x${"ab".repeat(32)}`,
    }
    const n = createNotifications({ db: openDatabase(memoryBackend()), now: () => NOW })
    for (const phase of ["sweeping", "claimed"] as const) {
      const listed = entries(
        sources({
          upgrades: { items: [keyed], recipients: new Set([addr("d1")]), loaded: true },
          deposits: { records: [deposit({ phase })], loaded: true, failed: false },
        }),
      )
      expect(listed).toHaveLength(1)
      await n.observe(listed, [], NOW, true)
      expect([...n.stamped.get()]).toEqual(expect.arrayContaining(listed.map((e) => e.id)))
    }
  })

  it("reports an upgrade read off its direct deposits once, however many legs join", () => {
    const direct = deposit({ direct: { portal: addr("f1") } } as Partial<SipaDeposit>)
    const s = sources({ deposits: { records: [direct], loaded: true, failed: false } })
    const done = entries(s).find((e) => e.id.endsWith(":done"))
    expect(done).toMatchObject({ id: `migration-run:chain-upgrade%2F${addr("f1")}:done` })
    expect(done).not.toHaveProperty("seenWith")
  })
})
