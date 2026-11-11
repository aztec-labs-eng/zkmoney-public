// @vitest-environment node
import { describe, expect, it } from "vitest"
import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import { createAccountRecord } from "../../src/engine/account"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import type { BalanceSync } from "../../src/engine/milestones"
import {
  createBalanceStore,
  createBalances,
  exceedsBalance,
  selectBalanceView,
  selectEntry,
  selectHomeMain,
  type BalanceEntry,
  type BalanceView,
  type WalletTokens,
} from "../../src/engine/balances"
import { memoryStore } from "../../src/engine/store"

const SCOPE = "sandbox:0xacct"
const MAIN = "0xMain"
const OLD = "0xOld"
const SHARES = "0xShares"
const START = 1_000
const SETTLED: BalanceSync = { syncing: false, progress: null }
const SYNCING: BalanceSync = { syncing: true, progress: 0.25 }

const entry = (token: string, atomic: bigint, readAt = START - 1, scope = SCOPE): BalanceEntry => ({
  scope,
  token,
  atomic,
  readAt,
  updatedAt: readAt,
})

const wallet = (active: string | null, tokens = [MAIN]): WalletTokens => ({
  scope: SCOPE,
  tokens,
  active,
})

const view = (entries: BalanceEntry[], w: WalletTokens | null, sync = SETTLED) =>
  selectBalanceView({ records: entries, loaded: true, failed: false }, w, sync, START)

const live = (atomic: bigint, over: Partial<BalanceView> = {}): BalanceView => ({
  main: { atomic },
  readThisSession: true,
  known: true,
  syncing: false,
  progress: null,
  readAt: START,
  token: MAIN,
  anchor: undefined,
  ...over,
})

describe("selectBalanceView", () => {
  // main: a wallet-token figure above zero
  it.each([
    { readThisSession: false, syncing: false, main: false, known: false },
    { readThisSession: false, syncing: false, main: true, known: true },
    { readThisSession: false, syncing: true, main: false, known: false },
    { readThisSession: false, syncing: true, main: true, known: false },
    { readThisSession: true, syncing: false, main: false, known: true },
    { readThisSession: true, syncing: false, main: true, known: true },
    { readThisSession: true, syncing: true, main: false, known: true },
    { readThisSession: true, syncing: true, main: true, known: true },
  ])("known when readThisSession=$readThisSession syncing=$syncing main=$main: $known", (row) => {
    const readAt = row.readThisSession ? START : START - 1
    const v = view(
      [entry(MAIN, row.main ? 5n : 0n, readAt)],
      wallet(MAIN),
      row.syncing ? SYNCING : SETTLED,
    )
    expect(v.readThisSession).toBe(row.readThisSession)
    expect(v.main !== null).toBe(row.main)
    expect(v.known).toBe(row.known)
  })

  it("passes the boot sync's progress through", () => {
    expect(view([], wallet(MAIN), SYNCING)).toMatchObject({ syncing: true, progress: 0.25 })
  })

  it("reads Main at the active address, case-insensitively, beside a row of the same token", () => {
    const v = view([entry(MAIN, 7n), entry(OLD, 9n)], wallet(MAIN.toUpperCase(), [OLD, MAIN]))
    expect(v.main).toEqual({ atomic: 7n })
  })

  it("takes a lone cached row before the address resolves", () => {
    expect(view([entry(MAIN, 7n), entry(OLD, 0n)], wallet(null, [OLD, MAIN])).main?.atomic).toBe(7n)
  })

  it("holds Savings' shares out of the candidates: their reads are not named", () => {
    expect(view([entry(MAIN, 7n), entry(SHARES, 3n)], wallet(null)).main?.atomic).toBe(7n)
  })

  it("guesses nothing when two cached rows hold funds and no address is known", () => {
    expect(view([entry(MAIN, 7n), entry(OLD, 9n)], wallet(null, [OLD, MAIN])).main).toBeNull()
  })

  it("ignores another scope and keeps a fresh install unknown", () => {
    const other = view([entry(MAIN, 7n, START, "testnet:0xacct")], wallet(MAIN))
    expect(other).toMatchObject({ main: null, readThisSession: false, known: false })
    expect(view([], null)).toMatchObject({ main: null, readThisSession: false, known: false })
  })

  it("has no read this session while neither the token nor a named read names Main", () => {
    expect(view([entry(MAIN, 7n, START)], wallet(null, [])).readThisSession).toBe(false)
  })

  it("reports when and at which block Main's balance was read, zero balances included", () => {
    const read = [{ ...entry(MAIN, 0n, 42), anchor: 9 }]
    expect(view(read, wallet(MAIN))).toMatchObject({ readAt: 42, token: MAIN, anchor: 9 })
    expect(view(read, wallet(null))).toMatchObject({ readAt: undefined, token: MAIN, anchor: 9 })
    expect(view(read, wallet(null, [OLD, MAIN]))).toMatchObject({ token: null, anchor: undefined })
    const held = [{ ...entry(MAIN, 7n, 42), anchor: 9 }, entry(OLD, 0n)]
    expect(view(held, wallet(null, [OLD, MAIN]))).toMatchObject({ token: MAIN, anchor: 9 })
  })

  it("counts a read as this session's by when it was written, and dates it by when it resolved", () => {
    const v = view([{ ...entry(MAIN, 7n, START - 5), updatedAt: START }], wallet(MAIN))
    expect(v).toMatchObject({ readThisSession: true, readAt: START - 5 })
  })
})

describe("exceedsBalance", () => {
  it("compares atomic units exactly against a live balance", () => {
    const balance = 2n * 10n ** 18n - 1n
    expect(exceedsBalance(live(balance), 2n * 10n ** 18n)).toBe(true)
    expect(exceedsBalance(live(balance), balance)).toBe(false)
    expect(exceedsBalance(live(0n, { main: null }), 1n)).toBe(true)
    expect(exceedsBalance(live(balance), undefined)).toBe(false)
  })

  it("never trusts a cached figure", () => {
    expect(exceedsBalance(live(0n, { readThisSession: false }), 10n)).toBe(false)
  })
})

describe("selectHomeMain", () => {
  const open = { checked: true, held: false }
  const args = { arriving: 3n, lock: open, upgradesLoaded: true }

  it("adds funds on their way to Main's balance", () => {
    expect(selectHomeMain(live(10n), args)).toEqual({ shown: 13n, known: true, updating: false })
    expect(selectHomeMain(live(0n, { main: null }), args).shown).toBe(3n)
  })

  it("marks a cached figure updating until a read from this session lands", () => {
    expect(selectHomeMain(live(10n, { readThisSession: false }), args)).toEqual({
      shown: 13n,
      known: true,
      updating: true,
    })
    expect(selectHomeMain(live(10n, { readThisSession: false, known: false }), args).updating).toBe(
      false,
    )
  })

  it("shows what a held upgrade will land, known once the lock is read", () => {
    const lock = { checked: true, held: true, main: 99n }
    expect(
      selectHomeMain(live(10n, { known: false, readThisSession: false }), { ...args, lock }),
    ).toEqual({
      shown: 99n,
      known: true,
      updating: false,
    })
  })

  it.each([{ lock: { checked: false, held: false } }, { upgradesLoaded: false }])(
    "waits on %o",
    (over) => {
      expect(selectHomeMain(live(10n), { ...args, ...over }).known).toBe(false)
    },
  )

  it("does not wait on the old versions' reads", () => {
    expect(selectHomeMain(live(10n, { syncing: true }), args)).toEqual({
      shown: 13n,
      known: true,
      updating: false,
    })
  })
})

const ACCOUNT = {
  type: "saved",
  completeAddress: "0xacct",
  signer: { credentialId: "c", pubkey: "p" },
} as const
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("createBalances", () => {
  /** Seeds through other instances, so the stores under test must read what is stored. */
  async function setup(seed: { account?: boolean; active?: string | null } = {}) {
    const db = openDatabase(memoryBackend())
    if (seed.account ?? true)
      await createAccountRecord({ db, now: () => Date.now() }).apply(ACCOUNT)
    const storage = createBalanceStore({ db, now: () => Date.now() })
    const accounts = createAccountRecord({ db, now: () => Date.now() })
    const sync = memoryStore<BalanceSync>(SETTLED)
    const active = memoryStore<string | null>(seed.active === undefined ? MAIN : seed.active)
    // Writes stamp the wall clock, long after this session start.
    const balances = createBalances(
      storage.view,
      { network: "sandbox", account: accounts.view, activeToken: active },
      sync.readonly,
      () => START,
    )
    balances.view.subscribe(() => {})
    await storage.ready
    await settle()
    return { storage, accounts, active, sync, balances }
  }

  it("reads the stored records and follows every write as a live read", async () => {
    const { storage, balances } = await setup()
    expect(balances.records.get().loaded).toBe(true)
    expect(balances.view.get()).toMatchObject({ main: null, readThisSession: false, known: false })
    await storage.write(SCOPE, MAIN, 5n, 10)
    expect(balances.view.get()).toMatchObject({
      main: { atomic: 5n },
      readThisSession: true,
      known: true,
    })
    expect(selectEntry(balances.records.get(), SCOPE, MAIN)).toMatchObject({
      atomic: 5n,
      anchor: 10,
    })
  })

  it("dates a read by when it resolved and follows a newer block of one balance", async () => {
    const { storage, balances } = await setup()
    await storage.write(SCOPE, MAIN, 5n, 10, 7)
    expect(balances.view.get()).toMatchObject({ readThisSession: true, readAt: 7, anchor: 10 })
    await storage.write(SCOPE, MAIN, 5n, 11, 7)
    expect(balances.view.get()).toMatchObject({ main: { atomic: 5n }, anchor: 11 })
  })

  it("names Main before the token builds by the symbol its read saved", async () => {
    const { storage, balances } = await setup({ active: null })
    await storage.write(SCOPE, OLD, 7n, 10)
    expect(balances.view.get()).toMatchObject({ main: null, known: false })
    await storage.write(SCOPE, MAIN, 5n, 10, undefined, WALLET_TOKEN_SYMBOL)
    expect(balances.view.get()).toMatchObject({
      main: { atomic: 5n },
      readThisSession: true,
      known: true,
    })
  })

  it("names Main by the active address, whatever symbol its read saved", async () => {
    const { storage, balances } = await setup()
    await storage.write(SCOPE, MAIN, 5n, 10, undefined, "USDC")
    expect(balances.view.get()).toMatchObject({
      main: { atomic: 5n },
      readThisSession: true,
      known: true,
    })
  })

  it("names Main by the token's address, with no symbol saved", async () => {
    const { storage, active, balances } = await setup({ active: null })
    await storage.write(SCOPE, MAIN, 5n, 10)
    expect(balances.view.get()).toMatchObject({ main: null, known: false })
    active.set(MAIN)
    expect(balances.view.get()).toMatchObject({
      main: { atomic: 5n },
      readThisSession: true,
      known: true,
    })
  })

  it("resolves when the account is stored after the first balance read", async () => {
    const { storage, accounts, balances } = await setup({ account: false })
    await storage.write(SCOPE, MAIN, 5n, 10)
    expect(balances.view.get()).toMatchObject({ main: null, known: false })
    await accounts.apply(ACCOUNT)
    await settle()
    expect(balances.view.get()).toMatchObject({ main: { atomic: 5n }, known: true })
  })

  it("joins the boot sync, so a cached figure waits while it runs", async () => {
    const { storage, accounts, active, sync } = await setup()
    await storage.write(SCOPE, MAIN, 5n, 1)
    const cached = createBalances(
      storage.view,
      { network: "sandbox", account: accounts.view, activeToken: active },
      sync.readonly,
      () => Date.now() + 60_000,
    )
    cached.view.subscribe(() => {})
    expect(cached.view.get()).toMatchObject({
      main: { atomic: 5n },
      readThisSession: false,
      known: true,
    })
    sync.set(SYNCING)
    expect(cached.view.get()).toMatchObject({ known: false, syncing: true, progress: 0.25 })
  })
})
