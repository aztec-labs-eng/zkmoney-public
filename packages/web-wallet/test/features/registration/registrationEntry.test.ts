// The pending entry over the session's registration and deposit stores: when the open
// registration's tag settles and its broadcast is owed, and when it never is.
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createRegistrations,
  createSipaDeposits,
  loadRecords,
  memoryBackend,
  memoryStore,
  openDatabase,
  queries,
  startRuntime,
  type PendingRegistrationRecord,
} from "@obsidion/front-core"
import { createPace } from "@obsidion/core/cadence"
import type { RegistrationSchedule } from "@obsidion/core/types"
import { registrationEntry } from "../../../src/features/registration/registrationTasks"
import {
  pendingRecord,
  registrationTerms,
  ticketBoundTerms,
} from "../../support/registrationFixtures"
import { PAID, RANDOM } from "../../support/registrationPrices"
import {
  fakeClock,
  flush,
  sessions,
  table,
  type Step,
} from "../../../../front-core/test/engine/taskTable"

fakeClock()

/** A price whose read lands once the test sets it. */
function later<T>(name: string) {
  let land!: (value: T) => void
  const value = new Promise<T>((resolve) => (land = resolve))
  const query = queries({
    pace: createPace({ signalled: false }),
    visible: memoryStore(true),
    now: () => Date.now(),
  })
  return { entry: query<[], T>(name, { load: () => value })(), ready: (v: T) => land(v) }
}

const ends: (() => void)[] = []
afterEach(() => {
  for (const end of ends.splice(0)) end()
})

const OTHER = "0x00000000000000000000000000000000000000c4"
const signed = (schedule: RegistrationSchedule, feeWaived?: boolean) =>
  registrationTerms({
    fee: String(schedule.fee),
    minDeposit: String(schedule.min),
    ...(feeWaived ? { feeWaived } : {}),
  })
/** A paid tag at its live signed quote: it settles with no price to read. */
const PAID_TAG = { fee: String(PAID.fee), route: "paid", terms: signed(PAID) } as const

async function entry(over: Partial<PendingRegistrationRecord> = PAID_TAG) {
  const db = openDatabase(memoryBackend()).scoped("a.")
  const sipaDeposits = createSipaDeposits({ db, account: true, now: () => Date.now() })
  const registrations = createRegistrations({
    db,
    legacy: openDatabase(memoryBackend()),
    deposits: sipaDeposits,
    account: true,
    now: () => Date.now(),
  })
  const open = async (record: Partial<PendingRegistrationRecord>) => {
    const { phase, broadcast, retries, startTime, terms, route, ...start } = pendingRecord(record)
    void [phase, broadcast, retries, startTime]
    await registrations.start({ type: "started", record: start, terms, route })
  }
  await open(over)
  const h = sessions(startRuntime)
  ends.push(h.end)
  const fee = later<bigint>("sweepFee")
  const schedule = later<RegistrationSchedule | null>("registrationSchedule")
  const linkFunds = vi.fn<(record: PendingRegistrationRecord) => boolean>(() => false)
  const confirmTag = vi.fn((record: PendingRegistrationRecord) =>
    registrations.confirmTag(record.sipaAddress).then(() => {}),
  )
  h.tasks.push(
    registrationEntry({
      registrations,
      sipaDeposits,
      withdrawals: { list: memoryStore({ records: [], hydrated: true }).readonly } as never,
      registrationRecovery: { refunded: () => false },
      sweepFee: fee.entry,
      registrationSchedule: schedule.entry,
      linkFunds,
      confirmTag,
    }),
  )
  const record = async (sipa = pendingRecord().sipaAddress) =>
    (await loadRecords(registrations.view)).find((r) => r.sipaAddress === sipa)
  const owed = async (sipa = pendingRecord().sipaAddress) =>
    (await sipaDeposits.get(sipa))?.broadcast
  /** The address shows `amount`, as the SIPA pass reads it. */
  const held = (amount: string) =>
    sipaDeposits.adopt({
      sipaAddress: pendingRecord().sipaAddress,
      phase: "resolved",
      networkId: "0xnet",
      amount: "0",
      startTime: 0,
      heldBalance: amount,
    } as never)
  return { h, fee, schedule, linkFunds, confirmTag, registrations, open, record, owed, held }
}

describe("registrationEntry", () => {
  it("checks every 5 s while visible, and pauses while hidden", async () => {
    const e = await entry()
    // A link on this tab keeps the record waiting, so every run reads it.
    e.linkFunds.mockReturnValue(true)
    const steps: Step[] = [
      ["start", e.h.start, 0, 1],
      ["visible", () => {}, 5_000, 2],
      ["hidden", e.h.hide, 20_000, 2],
      ["show", e.h.show, 0, 3],
      ["stop", e.h.stop, 20_000, 3],
      ["restart", e.h.start, 0, 4],
    ]
    await table(steps, () => e.linkFunds.mock.calls.length)
  })

  it("confirms the tag once it settles, which owes the address's broadcast once", async () => {
    const e = await entry()
    e.h.start()
    await vi.advanceTimersByTimeAsync(20_000)
    expect((await e.record())?.tagConfirmed).toBe(true)
    expect(await e.owed()).toMatchObject({ kind: "registration", state: "queued" })
    expect(e.confirmTag).toHaveBeenCalledTimes(1)
  })

  it.each<
    [string, Partial<PendingRegistrationRecord>, (e: Awaited<ReturnType<typeof entry>>) => void]
  >([
    ["a link on this tab funds it", PAID_TAG, (e) => e.linkFunds.mockReturnValue(true)],
    [
      "its quote lapsed",
      { ...PAID_TAG, terms: { ...signed(PAID), deadline: Math.floor(Date.now() / 1000) - 1 } },
      () => {},
    ],
    [
      "registrations are paused",
      { ...PAID_TAG, terms: registrationTerms() },
      (e) => e.schedule.ready(null),
    ],
    [
      "the earned price must refund a deposit its route expects",
      { route: "random", terms: signed(RANDOM, true) },
      (e) => void e.held("1").then(() => e.fee.ready(RANDOM.fee + 1n)),
    ],
    [
      "the signer priced its earned route at standard",
      { fee: String(PAID.fee), route: "random", terms: signed(PAID) },
      (e) => e.fee.ready(0n),
    ],
  ])("never confirms while %s", async (_, over, arrange) => {
    const e = await entry(over)
    arrange(e)
    e.h.start()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(e.confirmTag).not.toHaveBeenCalled()
    expect(await e.owed()).toBeUndefined()
  })

  it("waits for the sweep fee an earned tag's refund reads, and confirms once it lands", async () => {
    const e = await entry({ route: "random", terms: signed(RANDOM, true) })
    e.h.start()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(e.confirmTag).not.toHaveBeenCalled()
    e.fee.ready(0n)
    await flush()
    expect(e.confirmTag).toHaveBeenCalledTimes(1)
  })

  it("confirms a ticket signup's tag and a spent rail's, and owes neither a broadcast", async () => {
    const ticket = await entry({ ...PAID_TAG, terms: ticketBoundTerms() })
    ticket.h.start()
    await flush()
    expect((await ticket.record())?.tagConfirmed).toBe(true)
    expect(await ticket.owed()).toBeUndefined()

    const spent = await entry()
    await spent.open({ ...PAID_TAG, sipaAddress: OTHER, startTime: Date.now() + 1 })
    await spent.registrations.broadcastSent(pendingRecord().sipaAddress)
    spent.h.start()
    await flush()
    expect((await spent.record(OTHER))?.tagConfirmed).toBe(true)
    expect(await spent.owed(OTHER)).toBeUndefined()
  })

  it("backs off 5 s, doubling, while the write fails", async () => {
    const e = await entry()
    e.confirmTag.mockRejectedValueOnce(new Error("disk")).mockRejectedValueOnce(new Error("disk"))
    e.h.start()
    await flush()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(e.confirmTag).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(e.confirmTag).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(e.confirmTag).toHaveBeenCalledTimes(3)
    expect((await e.record())?.tagConfirmed).toBe(true)
  })
})
