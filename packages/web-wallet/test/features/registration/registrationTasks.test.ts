// The registration rail's tasks over fakes of their reads: each one's cadence, the milestones it
// waits for, its backoff, and the work it leaves undone.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import {
  createIdentity,
  createSipaDeposits,
  fixed,
  loadRecords,
  memoryBackend,
  memoryStore,
  openDatabase,
  stageIdentity,
  startRuntime,
  task,
  type IdentityView,
  type PendingRegistrationRecord,
} from "@obsidion/front-core"
import type {
  ContractService,
  ObsidionAccount,
  ObsidionWallet,
  waitForRegistrationMessage,
} from "@obsidion/sdk"
import type { Hex } from "viem"
import type { RegistrationPending } from "../../../src/features/registration/registrationRail"
import { makeRegistrationDepositSeeder } from "../../../src/features/registration/registrationDepositSeed"
import {
  sponsoredRailPending,
  type RailPending,
} from "../../../src/features/registration/sponsoredRailReadiness"
import {
  detectionCadence,
  registrationDetection,
  registrationHeal,
  registrationIdentity,
  registrationRederive,
  registrationRefunds,
  sponsoredRail,
} from "../../../src/features/registration/registrationTasks"
import type { WebDetectionDeps } from "../../../src/features/registration/webRegistration"
import { sessionTasks } from "../../../src/app/sessionTasks"
import { openSession, type SessionCore } from "../../../src/session/session"
import { pageSessionDeps } from "../../../src/app/sessionDeps"
import { testPage } from "../../support/page"
import { pendingRecord } from "../../support/registrationFixtures"
import { seedBootConfig } from "../../support/seedBootConfig"
import {
  fakeClock,
  flush,
  later,
  onceSteps,
  periodicSteps,
  sessions,
  table,
  type Step,
} from "../../../../front-core/test/engine/taskTable"

beforeAll(seedBootConfig)
fakeClock()
const ends: (() => void)[] = []
afterEach(() => {
  for (const end of ends.splice(0)) end()
})

function harness(after: () => Promise<boolean> = async () => true) {
  const h = sessions(startRuntime, { after, reached: () => false })
  ends.push(h.end)
  return h
}

/** A task with no needs, run every `every` ms while visible. */
const visibleSteps = (h: ReturnType<typeof harness>, every: number): Step[] => [
  ["start", h.start, 0, 1],
  ["visible", () => {}, every, 2],
  ["hidden", h.hide, 4 * every, 2],
  ["show", h.show, 0, 3],
  ["stop", h.stop, 4 * every, 3],
  ["restart", h.start, 0, 4],
]

const view = (records: PendingRegistrationRecord[]) =>
  memoryStore({ records, loaded: true, failed: false })
const funded = { fundedAt: 1 }

describe("detectionCadence", () => {
  it.each([
    ["a funded record", pendingRecord(funded), 0, 5_000],
    ["an unfunded one", pendingRecord(), 0, 45_000],
    ["an escalated one", pendingRecord({ ...funded, retries: 99 }), 0, 45_000],
    ["no record", null, 0, 45_000],
    ["a tick asking for longer", pendingRecord(funded), 30_000, 30_000],
  ])("waits for %s", (_label, record, nextMs, wait) => {
    expect(detectionCadence(record, nextMs)).toBe(wait)
  })
})

describe("registrationDetection", () => {
  function detection(records: PendingRegistrationRecord[] = [pendingRecord()]) {
    const h = harness()
    const registrations = view(records)
    const reads = later<WebDetectionDeps>("registrationReads")
    const demand = vi.fn()
    const tick = vi.fn(async () => ({ outcome: "pending" as const, nextMs: 0 }))
    reads.ready({} as WebDetectionDeps)
    h.tasks.push(
      registrationDetection({ view: registrations.readonly }, { ...reads.resource, demand }, tick),
    )
    return { h, registrations, demand, tick }
  }

  it("ticks every 45 s while a record waits on a deposit, and pauses while hidden", async () => {
    const d = detection()
    await table(visibleSteps(d.h, 45_000), () => d.tick.mock.calls.length)
  })

  it("reads nothing while no record is open, and ticks once one is", async () => {
    const d = detection([])
    d.h.start()
    await vi.advanceTimersByTimeAsync(90_000)
    expect(d.demand).not.toHaveBeenCalled()
    expect(d.tick).not.toHaveBeenCalled()
    d.registrations.set({ records: [pendingRecord()], loaded: true, failed: false })
    await vi.advanceTimersByTimeAsync(45_000)
    expect(d.demand).toHaveBeenCalled()
    expect(d.tick).toHaveBeenCalledTimes(1)
  })

  it("backs off 30 s after a failed tick, inside its 45 s cadence", async () => {
    const d = detection()
    d.tick.mockRejectedValueOnce(new Error("rpc"))
    d.h.start()
    await flush()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(d.tick).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(d.tick).toHaveBeenCalledTimes(2)
  })
})

describe("a session's detection", () => {
  it("runs at once when a record opens or its address shows its first funds, and not again", async () => {
    let runs = 0
    const probe = task("registrationDetection", {
      needs: {},
      every: "once",
      run: async () => void runs++,
    })
    const features = (core: SessionCore) => {
      const real = sessionTasks(core, testPage())
      return { ...real, tasks: [probe], named: { ...real.named, registrationDetection: probe } }
    }
    const deps = pageSessionDeps(testPage())({ id: "a", prefix: "a." })
    const own = openSession(
      Object.assign(deps, { database: openDatabase(memoryBackend()), features }),
    )
    ends.push(own.close)
    await own.registrations.ready
    await flush()
    expect(runs).toBe(1)
    const { phase, broadcast, retries, startTime, ...record } = pendingRecord()
    void [phase, broadcast, retries, startTime]
    await own.registrations.start({ type: "started", record })
    await flush()
    expect(runs).toBe(2)
    await own.registrations.apply(record.sipaAddress, { type: "funded" })
    await flush()
    expect(runs).toBe(2)
    // Its address's first funds, as a SIPA pass saves them, and not a later rise.
    const fields = { sipaAddress: record.sipaAddress, networkId: "0xnet", amount: "0" }
    await own.sipaDeposits.adopt({
      ...fields,
      phase: "resolved",
      startTime: 0,
      intent: "registration",
    } as never)
    const held = (heldBalance: string) =>
      own.db.write((w) =>
        own.sipaDeposits.applyAll(
          [[record.sipaAddress, { type: "observed", fields: { heldBalance } }]],
          w,
        ),
      )
    await held("5")
    await flush()
    expect(runs).toBe(3)
    await held("6")
    await flush()
    expect(runs).toBe(3)
  })
})

describe("the seeding tasks", () => {
  const WALLET = { networkId: "0xnet" } as ObsidionWallet
  const ALICE = { value: { handle: "alice", address: "0xa1", claimedAt: 1 }, loaded: true }
  function seeding(
    factory: typeof registrationRederive | typeof registrationHeal,
    after?: () => Promise<boolean>,
  ) {
    const h = harness(after)
    const wallet = later<ObsidionWallet>("wallet")
    const identity = memoryStore<IdentityView>({ ...ALICE, failed: false })
    const secret = vi.fn(async (): Promise<Fr | undefined> => Fr.ONE)
    const own = { identity, auth: { getSecretKey: secret }, config: () => ({}) } as never
    // No candidates for the rederive to seed; the heal's count is unread.
    const work = vi.fn(async () => ({ salts: [], fees: [] } as never))
    h.tasks.push(factory({ wallet: wallet.resource }, own, work))
    return { h, ready: () => wallet.ready(WALLET), identity, secret, work }
  }
  const FACTORIES = [
    ["registrationRederive", registrationRederive],
    ["registrationHeal", registrationHeal],
  ] as const

  it.each(FACTORIES)("%s runs once per session, once the wallet is ready", async (_n, factory) => {
    const s = seeding(factory)
    await table(onceSteps(s.h, s.ready), () => s.work.mock.calls.length)
  })

  it.each(FACTORIES)("%s waits for its milestones", async (_n, factory) => {
    let reach!: () => void
    const s = seeding(factory, () => new Promise((resolve) => (reach = () => resolve(true))))
    s.ready()
    s.h.start()
    await flush()
    expect(s.work).not.toHaveBeenCalled()
    reach()
    await flush()
    expect(s.work).toHaveBeenCalledTimes(1)
  })

  it.each(FACTORIES)("%s backs off without a name or a secret", async (_n, factory) => {
    const s = seeding(factory)
    s.secret.mockResolvedValueOnce(undefined)
    s.identity.set({ value: null, loaded: true, failed: false })
    s.ready()
    s.h.start()
    await flush()
    expect(s.work).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(s.work).not.toHaveBeenCalled()
    s.identity.set({ ...ALICE, failed: false })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(s.work).toHaveBeenCalledTimes(1)
  })
})

describe("registrationRederive", () => {
  const ALICE = { value: { handle: "alice", address: "0xa1", claimedAt: 1 }, loaded: true }
  const at = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex
  // The derivation's answers, by fee and salt: fixed, never computed from what the task passes.
  const DERIVED: Record<string, Hex> = {
    "0:": at(1),
    "5:": at(2),
    "0:0x5a": at(3),
    "5:0x5a": at(4),
  }

  it("seeds every fee under both salts, reading nothing but the derivations", async () => {
    const h = harness()
    const wallet = later<ObsidionWallet>("wallet")
    const deposits = createSipaDeposits({
      db: openDatabase(memoryBackend()).scoped("a."),
      account: true,
    })
    const ENV = { feeToken: "0xf0", l1ChainId: 1, networkId: "0xnet" }
    // A tracked address keeps its progress.
    const tracked = DERIVED["5:"]
    await makeRegistrationDepositSeeder(
      deposits,
      ENV,
    )({
      sipaAddress: tracked,
      messageSecret: "0x02",
      recipientHash: "0x03",
      origin: { protocol: "account" } as never,
      recipientL2Address: "0xa1",
      registrationFee: 5n,
    })
    await deposits.apply(tracked, { type: "observed", fields: { phase: "claimed", amount: "5" } })
    const before = await deposits.get(tracked)
    const derive = vi.fn(
      async ({ fee, sharedSecretSalt }: { fee: bigint; sharedSecretSalt?: Hex }) => ({
        sipaAddress: DERIVED[`${fee}:${sharedSecretSalt ?? ""}`],
        sharedSecretSalt: sharedSecretSalt ?? "0x01",
        recipientCommitment: "0x03",
        origin: { protocol: "account" },
      }),
    )
    // Only what the derivations and the seeder take: any other read has nothing to read with.
    const candidates = {
      deps: {
        masterSecret: Fr.ONE,
        l2Address: "0xa1",
        beneficiary: "0xbe",
        deriveRegistrationSipa: derive,
        seedSipaDeposit: makeRegistrationDepositSeeder(deposits, ENV),
      },
      owner: "0xc3",
      nameHash: "0x0d",
      fees: [0n, 5n],
      salts: [undefined, "0x5a"],
    }
    const own = {
      identity: memoryStore<IdentityView>({ ...ALICE, failed: false }),
      auth: { getSecretKey: async () => Fr.ONE },
      sipaDeposits: deposits,
      config: () => ({}),
    } as never
    h.tasks.push(
      registrationRederive({ wallet: wallet.resource }, own, async () => candidates as never),
    )
    wallet.ready({ networkId: "0xnet" } as ObsidionWallet)
    h.start()
    await flush()
    expect(derive).toHaveBeenCalledTimes(4)
    const seeded = await loadRecords(deposits.view)
    expect(seeded.map((r) => r.sipaAddress).sort()).toEqual([at(1), at(2), at(3), at(4)].sort())
    expect(seeded.every((r) => r.intent === "registration")).toBe(true)
    expect(await deposits.get(tracked)).toEqual(before)
  })
})

describe("registrationIdentity", () => {
  function entering(record = pendingRecord({ phase: "funded", fundedAt: 1 }), signedIn = true) {
    const h = harness()
    const page = openDatabase(memoryBackend())
    const identity = createIdentity({
      db: page.scoped("a."),
      legacy: page,
      opened: () => undefined,
    })
    const signed = vi.fn(() => signedIn)
    h.tasks.push(
      registrationIdentity({
        registrations: { view: view([record]).readonly },
        sipaDeposits: { view: memoryStore({ records: [], loaded: true, failed: false }).readonly },
        identity,
        signedIn: signed,
        save: (value) => page.write(async (w) => stageIdentity(w, "a.", value)),
      }),
    )
    return { h, record, identity, signed }
  }

  it("runs every 5 s while visible, paused while hidden, from each start", async () => {
    const r = entering(undefined, false)
    await r.identity.ready
    await table(visibleSteps(r.h, 5_000), () => r.signed.mock.calls.length)
  })

  it("commits a settled record's tag as the identity once, pending until it confirms", async () => {
    const r = entering()
    r.h.start()
    await vi.advanceTimersByTimeAsync(5_000)
    const saved = r.identity.get().value
    expect(saved).toMatchObject({
      handle: r.record.tag,
      address: r.record.l2Address,
      pending: true,
    })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(r.identity.get().value).toEqual(saved)
  })

  it("commits no name for an account that holds another one", async () => {
    const r = entering(pendingRecord({ phase: "confirmed", notice: { recovery: true } }))
    r.h.start()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(r.identity.get()).toMatchObject({ loaded: true, value: null })
  })

  it("commits nothing for a record still owed its deposit, or for a signed-out session", async () => {
    const owed = entering(pendingRecord())
    const out = entering(undefined, false)
    owed.h.start()
    out.h.start()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(owed.identity.get().value).toBeNull()
    expect(out.identity.get().value).toBeNull()
  })
})

describe("registrationRefunds", () => {
  function refunds(records = [pendingRecord()]) {
    const h = harness()
    const reconcile = vi.fn(async () => {})
    h.tasks.push(
      registrationRefunds({
        registrations: { view: view(records).readonly },
        sipaDeposits: { view: memoryStore({ records: [], loaded: true, failed: false }).readonly },
        recovery: { reconcile },
      }),
    )
    return { h, reconcile }
  }

  it("reconciles each record every 15 s while visible", async () => {
    const r = refunds([pendingRecord(), pendingRecord({ sipaAddress: "0xc4" })])
    await table(visibleSteps(r.h, 15_000), () => r.reconcile.mock.calls.length / 2)
  })

  it("backs off, doubling, while a reconcile fails", async () => {
    const r = refunds()
    r.reconcile.mockRejectedValue(new Error("rpc"))
    r.h.start()
    await flush()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(r.reconcile).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(r.reconcile).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(r.reconcile).toHaveBeenCalledTimes(3)
  })
})

describe("sponsoredRail", () => {
  const MESSAGE: RegistrationPending = { pending: "message" }
  const IMPORT: RegistrationPending = { pending: "import", messageHash: Fr.ONE }
  function rail() {
    const read = vi.fn<typeof sponsoredRailPending>(async () => MESSAGE)
    const h = harness()
    const account = later<ObsidionAccount>("account")
    const railPending = memoryStore<RailPending>(undefined)
    const imported = vi.fn<typeof waitForRegistrationMessage>(() => new Promise(() => {}))
    const needs = {
      wallet: fixed("wallet", { node: {} } as ObsidionWallet),
      account: account.resource,
      contractService: fixed("contractService", {} as ContractService),
    }
    h.tasks.push(sponsoredRail(needs, railPending, { read, imported }))
    const ready = () => account.ready({} as ObsidionAccount)
    return { h, account, railPending, read, imported, ready }
  }

  it("asks every 12 s while pending, and pauses while hidden", async () => {
    const r = rail()
    await table(periodicSteps(r.h, r.ready, 12_000), () => r.read.mock.calls.length)
    expect(r.railPending.get()).toEqual(MESSAGE)
  })

  it("stops asking once the account can ride the rail", async () => {
    const r = rail()
    r.read.mockResolvedValueOnce(MESSAGE).mockResolvedValue(false)
    r.ready()
    r.h.start()
    await vi.advanceTimersByTimeAsync(12_000)
    expect(r.railPending.get()).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(r.read).toHaveBeenCalledTimes(2)
  })

  it("keeps a read that cannot answer as read-error", async () => {
    const r = rail()
    r.read.mockImplementation(sponsoredRailPending)
    r.ready()
    r.h.start()
    await flush()
    expect(r.railPending.get()).toEqual({ pending: "read-error" })
  })

  it("asks again once the message imports, and ends its wait with the run", async () => {
    const r = rail()
    r.read.mockResolvedValue(IMPORT)
    let imported!: () => void
    r.imported.mockReturnValueOnce(
      new Promise<boolean>((resolve) => (imported = () => resolve(true))),
    )
    r.ready()
    r.h.start()
    await flush()
    expect(r.read).toHaveBeenCalledTimes(1)
    imported()
    await flush()
    expect(r.read).toHaveBeenCalledTimes(2)
    // The second wait never ends on its own: losing the account ends it.
    r.account.lose()
    r.ready()
    await flush()
    expect(r.read).toHaveBeenCalledTimes(3)
  })
})
