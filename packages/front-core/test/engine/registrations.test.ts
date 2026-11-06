// @vitest-environment node
import { describe, expect, it } from "vitest"
import type { Address } from "viem"
import { CompleteAddress } from "@aztec-labs/stdlib/contract"
import { ACCOUNT_STORAGE_KEY } from "../../src/core/storages/constants"
import { PENDING_REGISTRATION_STORAGE_KEY } from "../../src/engine/registrationRecord"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend, type MemoryBackend } from "../../src/engine/memoryBackend"
import { loadRecords } from "../../src/engine/persistentStore"
import {
  createRegistrations,
  registrationSpentLink,
  type PendingRegistrationRecord,
} from "../../src/engine/registrations"
import {
  createSipaDeposits,
  KEY_SIPA_DEPOSITS,
  type SipaDeposit,
} from "../../src/engine/sipaDeposits"

const NS = "obsidion.ns."
const ACCOUNT = "0x00000000000000000000000000000000000000C3"
const OTHER_ACCOUNT = "0x00000000000000000000000000000000000000f6"
const OPEN = "0x00000000000000000000000000000000000000A1" as Address
const CLOSED = "0x00000000000000000000000000000000000000b2" as Address
const ARCHIVED = "0x00000000000000000000000000000000000000c4" as Address
const FOREIGN = "0x00000000000000000000000000000000000000d5" as Address
const TX = `0x${"cd".repeat(32)}`
const CORRUPT = "{not json"

const legacyRecord = (
  over: Partial<PendingRegistrationRecord> = {},
): PendingRegistrationRecord => ({
  account: ACCOUNT,
  tag: "alice",
  nameHash: `0x${"11".repeat(32)}`,
  l2Address: `0x${"22".repeat(32)}`,
  l1ChainId: 1,
  sipaAddress: OPEN,
  fee: "10",
  beneficiary: "0x00000000000000000000000000000000000000d4",
  depositToken: "0x00000000000000000000000000000000000000e5",
  broadcast: false,
  phase: "awaiting_deposit",
  retries: 0,
  startTime: 100,
  ...over,
})

/** A blob older builds kept, keyed by lowercase account, and the device-wide side keys. */
function seed(
  backend: MemoryBackend,
  records: readonly PendingRegistrationRecord[],
  side: Record<string, unknown> = {},
) {
  backend.entries.set(
    NS + PENDING_REGISTRATION_STORAGE_KEY,
    JSON.stringify(Object.fromEntries(records.map((r) => [r.account.toLowerCase(), r]))),
  )
  for (const [key, value] of Object.entries(side))
    backend.entries.set(
      `webwallet.registration.${key}`,
      typeof value === "string" ? value : JSON.stringify(value),
    )
}

function open(backend: MemoryBackend, account = true) {
  const page = openDatabase(backend)
  const db = page.scoped(NS)
  const deposits = createSipaDeposits({ db, account })
  const store = createRegistrations({ db, legacy: page, deposits, account })
  const byAddress = async (address: string) =>
    (await loadRecords(store.view)).find(
      (r) => r.sipaAddress.toLowerCase() === address.toLowerCase(),
    )
  return { db, deposits, store, byAddress }
}

const owed = async (deposits: ReturnType<typeof open>["deposits"], address: string) =>
  (await deposits.get(address))?.broadcast

describe("createRegistrations migration", () => {
  it("carries every record, closed ones too, keyed by address and without its retry floor", async () => {
    const backend = memoryBackend()
    const closed = legacyRecord({
      account: OTHER_ACCOUNT,
      sipaAddress: CLOSED,
      phase: "confirmed",
      fundedAt: 150,
      endTime: 200,
    })
    seed(backend, [{ ...legacyRecord(), nextAttemptAt: 5 } as PendingRegistrationRecord, closed])
    const { store, db } = open(backend)

    const records = await loadRecords(store.view)
    expect(records.map((r) => r.sipaAddress).sort()).toEqual([OPEN, CLOSED].sort())
    expect(records.find((r) => r.sipaAddress === OPEN)).not.toHaveProperty("nextAttemptAt")
    // A funding an older build saw is the record's first.
    expect(records.find((r) => r.sipaAddress === CLOSED)?.firstFundedAt).toBe(150)
    expect(await db.get(`acct/registrations/${OPEN.toLowerCase()}`)).toBeDefined()
    // The blob stays for a rollback, and nothing writes it again.
    expect(backend.entries.has(NS + PENDING_REGISTRATION_STORAGE_KEY)).toBe(true)
  })

  it("carries an archive with no live record when it registers the namespace's own account", async () => {
    const backend = memoryBackend()
    const complete = await CompleteAddress.random()
    const own = legacyRecord({
      sipaAddress: ARCHIVED,
      l2Address: complete.address.toString(),
      phase: "failed_terminal",
      endTime: 60,
    })
    const other = legacyRecord({ sipaAddress: FOREIGN, l2Address: `0x${"33".repeat(32)}` })
    seed(backend, [], { replaced: [own, other] })
    backend.entries.set(
      NS + ACCOUNT_STORAGE_KEY,
      JSON.stringify({ completeAddress: complete.toString() }),
    )
    const { byAddress } = open(backend)

    expect(await byAddress(ARCHIVED)).toMatchObject({ phase: "replaced" })
    expect(await byAddress(FOREIGN)).toBeUndefined()
  })

  it.each([
    [
      "a blob that does not parse",
      (b: MemoryBackend) => b.entries.set(NS + PENDING_REGISTRATION_STORAGE_KEY, CORRUPT),
    ],
    [
      "a record with no committed fee",
      (b: MemoryBackend) => seed(b, [{ ...legacyRecord(), fee: undefined } as never]),
    ],
    [
      "a replaced archive that does not parse",
      (b: MemoryBackend) => seed(b, [legacyRecord()], { replaced: CORRUPT }),
    ],
    [
      "a bad replaced record",
      (b: MemoryBackend) => seed(b, [legacyRecord()], { replaced: [{ phase: "x" }] }),
    ],
  ])("fails the open over %s, keeps the bytes and refuses every write", async (_, damage) => {
    const backend = memoryBackend()
    damage(backend)
    const saved = new Map(backend.entries)
    const { store } = open(backend)

    await expect(store.ready).rejects.toThrow()
    expect(store.view.get()).toMatchObject({ failed: true, records: [] })
    await expect(store.apply(OPEN, { type: "retried" })).rejects.toThrow()
    for (const [key, value] of saved) expect(backend.entries.get(key)).toBe(value)
    expect([...backend.entries.keys()].filter((k) => k.includes("registrations"))).toEqual([])
  })

  describe("folds a side key onto the record it names, and leaves one naming none", () => {
    const archived = legacyRecord({
      sipaAddress: ARCHIVED,
      phase: "failed_terminal",
      startTime: 50,
      endTime: 60,
    })
    const foreign = legacyRecord({ account: OTHER_ACCOUNT, sipaAddress: FOREIGN, startTime: 10 })
    const terms = { account: ACCOUNT, tag: "alice", deadline: 7, fee: "10", minDeposit: "20" }
    const cases: [string, Record<string, unknown>, Partial<PendingRegistrationRecord>][] = [
      [
        "terms",
        {
          [`terms:${ACCOUNT.toLowerCase()}:alice`]: terms,
          [`terms:${OTHER_ACCOUNT.toLowerCase()}:alice`]: { ...terms, deadline: 9 },
        },
        { terms: { deadline: 7, fee: "10", minDeposit: "20" } },
      ],
      [
        "confirmed",
        { confirmed: [OPEN.toLowerCase(), FOREIGN.toLowerCase()] },
        { tagConfirmed: true },
      ],
      [
        "refunds",
        {
          refunds: {
            [OPEN.toLowerCase()]: {
              token: "0x1",
              l1ChainId: 9,
              txHashes: [TX],
              amounts: { [TX]: "3" },
            },
            [FOREIGN.toLowerCase()]: { token: "0x1", l1ChainId: 1, txHashes: [TX] },
          },
        },
        { refunds: { txHashes: [TX], amounts: { [TX]: "3" } } },
      ],
      ["route", { route: { tag: "alice", route: "past_user" } }, { route: "past_user" }],
    ]

    it.each(cases)("%s", async (_, side, folded) => {
      const backend = memoryBackend()
      seed(backend, [legacyRecord()], { ...side, replaced: [archived, foreign] })
      const { byAddress } = open(backend)

      expect(await byAddress(OPEN)).toMatchObject(folded)
      // The archive's record of this account is carried, closed, without the open one's fields.
      const kept = await byAddress(ARCHIVED)
      expect(kept?.phase).toBe("replaced")
      for (const field of Object.keys(folded)) expect(kept).not.toHaveProperty(field)
      // Another account's archived record is not this namespace's.
      expect(await byAddress(FOREIGN)).toBeUndefined()
    })

    it("recovery: on the newest confirmed record of its tag", async () => {
      const backend = memoryBackend()
      const confirmed = legacyRecord({ phase: "confirmed", endTime: 300 })
      seed(backend, [confirmed], { recovery: "alice", replaced: [archived] })
      const { byAddress } = open(backend)

      expect((await byAddress(OPEN))?.notice).toEqual({ recovery: true })
      expect(await byAddress(ARCHIVED)).not.toHaveProperty("notice")
    })

    it("noticeAck: on the record whose close it names", async () => {
      const backend = memoryBackend()
      const taken = legacyRecord({ phase: "failed_taken", endTime: 300 })
      seed(backend, [taken], {
        noticeAck: `${ACCOUNT.toLowerCase()}:60:failed_terminal`,
        replaced: [archived],
      })
      const { byAddress } = open(backend)

      expect((await byAddress(ARCHIVED))?.notice).toEqual({ acknowledged: true })
      expect(await byAddress(OPEN)).not.toHaveProperty("notice")
    })

    it("route: only on the newest record of its tag", async () => {
      const backend = memoryBackend()
      seed(backend, [legacyRecord()], {
        route: { tag: "bob", route: "invite" },
        replaced: [archived],
      })
      const { byAddress } = open(backend)

      expect(await byAddress(OPEN)).not.toHaveProperty("route")
    })
  })

  describe("owes the broadcast an older build's confirmation never saved", () => {
    it.each([
      ["a confirmed tag", { confirmed: [OPEN.toLowerCase()] }, {}],
      ["a route that confirms it", { route: { tag: "alice", route: "invite" } }, {}],
      ["a deposit already at the address", {}, { phase: "funded", fundedAt: 5 }],
    ])("for %s", async (_, side, over) => {
      const backend = memoryBackend()
      seed(backend, [legacyRecord(over as Partial<PendingRegistrationRecord>)], side)
      const { store, deposits } = open(backend)
      await store.ready

      expect(await owed(deposits, OPEN)).toMatchObject({
        kind: "registration",
        source: { type: "registration", account: ACCOUNT },
        state: "queued",
      })
    })

    it.each([
      ["an unconfirmed tag", {}, {}],
      ["a published address", { confirmed: [OPEN.toLowerCase()] }, { broadcast: true }],
      [
        "a rail its predecessor spent",
        { confirmed: [OPEN.toLowerCase()] },
        { replaced: { sipaAddress: CLOSED, refunded: false, broadcastSpent: true } },
      ],
      ["a closed record", { confirmed: [OPEN.toLowerCase()] }, { phase: "confirmed", endTime: 1 }],
    ])("and not for %s", async (_, side, over) => {
      const backend = memoryBackend()
      seed(backend, [legacyRecord(over as Partial<PendingRegistrationRecord>)], side)
      const { store, deposits } = open(backend)
      await store.ready

      expect(await owed(deposits, OPEN)).toBeUndefined()
    })

    it("and not for a ticket signup, whose claim publishes the address", async () => {
      const backend = memoryBackend()
      seed(backend, [legacyRecord()], {
        confirmed: [OPEN.toLowerCase()],
        [`terms:${ACCOUNT.toLowerCase()}:alice`]: {
          deadline: 7,
          paylinkFunded: true,
          paylinkId: "link",
        },
      })
      const { store, deposits } = open(backend)
      await store.ready

      expect(await owed(deposits, OPEN)).toBeUndefined()
    })

    it("and leaves one already owed as it is", async () => {
      const backend = memoryBackend()
      seed(backend, [legacyRecord()], { confirmed: [OPEN.toLowerCase()] })
      const job = { kind: "registration", source: { type: "registration", account: ACCOUNT } }
      const deposit = { sipaAddress: OPEN, phase: "broadcast", startTime: 1 } as SipaDeposit
      backend.entries.set(
        NS + KEY_SIPA_DEPOSITS,
        JSON.stringify({
          [OPEN.toLowerCase()]: {
            ...deposit,
            broadcast: { ...job, state: "landed", createdAt: 1, failures: 0 },
          },
        }),
      )
      const { store, deposits } = open(backend)
      await store.ready

      expect((await owed(deposits, OPEN))?.state).toBe("landed")
    })

    it("on a deposit store that migrates in the same open", async () => {
      const backend = memoryBackend()
      seed(backend, [legacyRecord()], { confirmed: [OPEN.toLowerCase()] })
      backend.entries.set(
        NS + KEY_SIPA_DEPOSITS,
        JSON.stringify({
          [CLOSED.toLowerCase()]: { sipaAddress: CLOSED, phase: "funded", startTime: 1 },
        }),
      )
      const { store, deposits } = open(backend)
      await store.ready

      expect(await owed(deposits, OPEN)).toMatchObject({ state: "queued" })
      expect(await deposits.get(CLOSED)).toBeDefined()
    })
  })
})

describe("createRegistrations ready", () => {
  it("settles once the view holds a record started while its first load reads", async () => {
    const backend = memoryBackend()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    // The view loads its records in one whole range; the open reads in chunks.
    const page = openDatabase({
      ...backend,
      range: async (prefix, opts) => {
        if (prefix === `${NS}acct/registrations/` && opts?.limit === undefined) await held
        return backend.range(prefix, opts)
      },
    })
    const db = page.scoped(NS)
    const deposits = createSipaDeposits({ db, account: true })
    const store = createRegistrations({ db, legacy: page, deposits, account: true })
    const { phase, broadcast, retries, startTime, ...start } = legacyRecord()
    void [phase, broadcast, retries, startTime]
    await store.start({ type: "started", record: start })

    release()
    await store.ready
    expect(store.view.get().records.map((r) => r.sipaAddress)).toEqual([OPEN])
  })
})

describe("createRegistrations writes", () => {
  it("changes a record through the transition, in one commit the view follows", async () => {
    const backend = memoryBackend()
    seed(backend, [legacyRecord()])
    const { store, byAddress } = open(backend)
    await store.ready

    const change = await store.apply(OPEN, { type: "funded", fundingTxHash: TX as Address })
    expect(change?.first).toContain("fundedAt")
    expect((await byAddress(OPEN))?.phase).toBe("funded")
    expect(await store.apply(OPEN, { type: "funded" })).toBeUndefined()
  })

  it("keeps both of two changes applied at once to one record in one write", async () => {
    const backend = memoryBackend()
    seed(backend, [legacyRecord()])
    const { db, store, byAddress } = open(backend)
    await store.ready

    await db.write((w) =>
      Promise.all([
        store.apply(OPEN, { type: "tagConfirmed" }, w),
        store.apply(OPEN, { type: "termsUpdated", terms: { proverTip: "4" } }, w),
      ]),
    )
    expect(await byAddress(OPEN)).toMatchObject({ tagConfirmed: true, terms: { proverTip: "4" } })
  })

  it("owes the broadcast in the write that confirms the tag, once", async () => {
    const backend = memoryBackend()
    seed(backend, [legacyRecord()])
    const { store, deposits } = open(backend)
    await store.ready

    expect((await store.confirmTag(OPEN))?.record.tagConfirmed).toBe(true)
    expect(await owed(deposits, OPEN)).toMatchObject({ kind: "registration", state: "queued" })
    expect(await store.confirmTag(OPEN)).toBeUndefined()
  })

  it.each([
    ["a ticket signup", { terms: { deadline: 1, paylinkFunded: true, paylinkId: "l" } }],
    ["a spent rail", { replaced: { sipaAddress: CLOSED, refunded: false, broadcastSpent: true } }],
    ["a published address", { broadcast: true }],
  ])("confirms the tag of %s and owes nothing", async (_, over) => {
    const backend = memoryBackend()
    seed(backend, [legacyRecord(over as Partial<PendingRegistrationRecord>)])
    const { store, deposits } = open(backend)
    await store.ready

    await store.confirmTag(OPEN)
    expect(await owed(deposits, OPEN)).toBeUndefined()
  })

  it("keeps a renewal's link binding and committed choices on the same open address", async () => {
    const link = {
      deadline: 1,
      paylinkFunded: true,
      paylinkId: "l",
      paylinkDeposit: true,
      proverTip: "4",
      speed: "faster" as const,
      earnedExpected: true,
    }
    const backend = memoryBackend()
    seed(backend, [legacyRecord({ terms: link })])
    const { store, byAddress } = open(backend)
    await store.ready

    const { phase, broadcast, retries, startTime, terms, ...start } = legacyRecord()
    void [phase, broadcast, retries, startTime, terms]
    await store.start({ type: "started", record: start, terms: { deadline: 2, fee: "10" } })
    expect((await byAddress(OPEN))?.terms).toEqual({ ...link, deadline: 2, fee: "10" })
  })

  it.each([
    ["a settled tag", { tagConfirmed: true }, { kind: "registration", state: "queued" }],
    ["a tag still open", {}, undefined],
  ])(
    "drops a released link's binding and, for %s, owes the broadcast in that write",
    async (_, over, broadcast) => {
      const terms = { deadline: 1, paylinkFunded: true, paylinkId: "l", paylinkDeposit: true }
      const backend = memoryBackend()
      seed(backend, [legacyRecord({ terms, ...over })])
      const { store, deposits, byAddress } = open(backend)
      await store.ready

      await store.releaseLink(OPEN)
      expect((await byAddress(OPEN))?.terms).toEqual({ deadline: 1 })
      if (broadcast) expect(await owed(deposits, OPEN)).toMatchObject(broadcast)
      else expect(await owed(deposits, OPEN)).toBeUndefined()
    },
  )

  it("hears each change it committed, after the commit, with the fields first set", async () => {
    const heard: string[][] = []
    const backend = memoryBackend()
    seed(backend, [legacyRecord()])
    const page = openDatabase(backend)
    const db = page.scoped(NS)
    const deposits = createSipaDeposits({ db, account: true })
    const store = createRegistrations({
      db,
      legacy: page,
      deposits,
      account: true,
      committed: (changes) => {
        // The view already holds what was heard.
        expect(store.view.get().records.find((r) => r.phase === "funded")).toBeDefined()
        heard.push(changes.flatMap((c) => c.first))
      },
    })
    await store.ready

    await store.apply(OPEN, { type: "funded" })
    await store.apply(OPEN, { type: "funded" })
    expect(heard).toEqual([["fundedAt", "firstFundedAt"]])
  })

  it("refuses a write with no account session", async () => {
    const { store } = open(memoryBackend(), false)
    await store.ready

    await expect(store.apply(OPEN, { type: "retried" })).rejects.toMatchObject({
      code: "wallet.notReady",
    })
  })
})

describe("registrationSpentLink", () => {
  const LINK = `0x${"ab".repeat(32)}`
  const ticket = (phase: PendingRegistrationRecord["phase"]) =>
    legacyRecord({ phase, terms: { feeWaived: true, paylinkFunded: true, paylinkId: LINK } })
  const claim = (phase: string) => [{ recipient: OPEN, phase }]

  it("spends the link a confirmed signup's claim burned, so its claim is never offered again", () => {
    expect(registrationSpentLink([ticket("confirmed")], LINK, claim("completed"))).toBe(true)
    expect(registrationSpentLink([ticket("failed_taken")], LINK, claim("l2_mined"))).toBe(true)
  })

  it("leaves a closed signup's unclaimed link claimable", () => {
    for (const phase of ["failed_taken", "failed_terminal", "replaced", "confirmed"] as const)
      expect(registrationSpentLink([ticket(phase)], LINK, [])).toBe(false)
    expect(registrationSpentLink([ticket("failed_taken")], LINK, claim("failed"))).toBe(false)
    const elsewhere = [{ recipient: `0x${"99".repeat(20)}`, phase: "completed" }]
    expect(registrationSpentLink([ticket("failed_taken")], LINK, elsewhere)).toBe(false)
  })

  it("spends no link the records do not bind", () => {
    expect(
      registrationSpentLink([ticket("confirmed")], `0x${"cd".repeat(32)}`, claim("completed")),
    ).toBe(false)
    expect(
      registrationSpentLink([legacyRecord({ phase: "confirmed" })], LINK, claim("completed")),
    ).toBe(false)
  })
})
