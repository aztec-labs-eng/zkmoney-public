import { describe, expect, it, vi } from "vitest"
import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"
import { QueueStatus } from "@obsidion/sdk"
import {
  ACCOUNT_STORAGE_KEY,
  HISTORIC_ACTIVITY_IMPORTED_KEY,
  importHistoricActivity,
  retiredDatabaseOf,
  retiredSipaDeposit,
  TRANSACTIONS_STORAGE_KEY,
  scannedNetworks,
  type RetiredDatabase,
  type WithdrawalRecord,
} from "../../src/core"
import { createTransfers } from "../../src/engine/transfers"
import { createMoveStore } from "../../src/engine/moves"
import type { SavedSavingsMove } from "../../src/storageMigrations/savingsMoves"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import { scannedRow } from "../../src/core/services/transactions/TransferEventScanner"
import { encodeRecord, loadRecords } from "../../src/engine/persistentStore"
import { createSipaDeposits, type SipaDeposit } from "../../src/engine/sipaDeposits"
import { createWithdrawals } from "../../src/engine/withdrawals"
import { KEY_SIPA_DEPOSITS } from "../../src/storageMigrations/sipaDeposits"
import { KEY_WITHDRAWALS } from "../../src/storageMigrations/withdrawals"
import type { TokenInTxService, TokenTransaction, Transaction } from "../../src/types"

const ACTIVE = "0xactive"
const OLD = "0xold"
const ACCOUNT = "0xacc"

const token: TokenInTxService = {
  name: "USDC",
  decimals: 6,
  logo: "",
  price: 1,
  symbol: "USDC",
  address: "0xtoken",
  amount: 5,
  hasUnknownAmount: false,
}

/** A row as a retired database holds it, in the legacy format. */
const row = (overrides: Partial<TokenTransaction> & { queueId?: string }): TokenTransaction =>
  ({
    action: "send",
    token,
    timestamp: 1_000,
    status: "success",
    txHash: "0xA1",
    from: ACCOUNT,
    to: "0xbob",
    ...overrides,
  } as TokenTransaction)

const deposit = (overrides: Partial<SipaDeposit>): SipaDeposit =>
  ({
    sipaAddress: "0xsipa1",
    recipientL2Address: ACCOUNT,
    messageSecret: "s",
    recipientHash: "h",
    recoveryAddress: "0xrecover",
    l1ChainId: 1,
    amount: "100",
    tokenSymbol: "USDC",
    phase: "claimed",
    startTime: 1_000,
    ...overrides,
  } as SipaDeposit)

const withdrawal = (overrides: Partial<WithdrawalRecord>): WithdrawalRecord =>
  ({
    localId: "w1",
    phase: "done",
    startTime: 1_000,
    amount: "5",
    ...overrides,
  } as WithdrawalRecord)

const cursorKey = (networkId: string) => `@obsidion/transfer-scan/cursor/v1/${networkId}/${ACCOUNT}`

const retired = retiredDatabaseOf

function database(
  version: string,
  o: {
    rows?: Transaction[]
    deposits?: SipaDeposit[]
    withdrawals?: WithdrawalRecord[]
    savingsMoves?: Partial<SavedSavingsMove>[]
    scanned?: string[]
    extra?: Record<string, string>
  },
): RetiredDatabase {
  const entries: Record<string, string> = { ...o.extra }
  if (o.rows) entries[TRANSACTIONS_STORAGE_KEY] = JSON.stringify(o.rows)
  if (o.deposits)
    entries[KEY_SIPA_DEPOSITS] = JSON.stringify(
      Object.fromEntries(o.deposits.map((d) => [d.sipaAddress, d])),
    )
  if (o.withdrawals)
    entries[KEY_WITHDRAWALS] = JSON.stringify(
      Object.fromEntries(o.withdrawals.map((w) => [w.localId, w])),
    )
  if (o.savingsMoves)
    entries["@obsidion/savings/moves"] = JSON.stringify(
      Object.fromEntries(o.savingsMoves.map((m) => [m.withdrawalLocalId, m])),
    )
  for (const id of o.scanned ?? []) entries[cursorKey(id)] = "42"
  return retired(version, entries)
}

const readOf =
  (dbs: RetiredDatabase[]) =>
  <T>(read: (db: RetiredDatabase) => T) =>
    Promise.resolve(dbs.map(read))

function setup() {
  const storage = new InMemoryStorageAdapter()
  const transactions = createTransfers({ db: openDatabase(memoryBackend()), now: () => Date.now() })
  const sipaBackend = memoryBackend()
  const sipaDeposits = createSipaDeposits({
    db: openDatabase(sipaBackend),
    account: true,
    now: () => Date.now(),
  })
  const withdrawals = createWithdrawals({
    db: openDatabase(memoryBackend()),
    now: () => Date.now(),
  })
  const moves = createMoveStore(openDatabase(memoryBackend()))
  const deps = (dbs: RetiredDatabase[], ownsStorage?: () => boolean) => ({
    storage,
    readOtherDatabases: readOf(dbs),
    transactions,
    sipaDeposits,
    withdrawals,
    moves,
    skyHolding: { id: "fea-sky", factory: `0x${"fa".repeat(20)}` },
    now: () => 5_000,
    ownsStorage,
  })
  return { storage, transactions, sipaDeposits, sipaBackend, withdrawals, moves, deps }
}

describe("importHistoricActivity", () => {
  it("carries rows and settled deposits and withdrawals over, stamped with the retired network", async () => {
    const { storage, transactions, sipaDeposits, withdrawals, deps } = setup()
    const db = database("7", {
      scanned: [OLD],
      rows: [
        row({ txHash: "0xA1" }),
        row({ txHash: "0xA2", action: "receive", from: "0xbob", to: ACCOUNT }),
        row({
          txHash: "0xA3",
          status: "pending",
          queueId: "q1",
          detailedStatus: QueueStatus.PENDING,
        }),
      ],
      deposits: [deposit({}), deposit({ sipaAddress: "0xsipa2", phase: "swept" })],
      withdrawals: [withdrawal({}), withdrawal({ localId: "w2", phase: "submitting" })],
    })

    const result = await importHistoricActivity(deps([db]))

    expect(result).toEqual({
      databases: 1,
      transactions: 3,
      deposits: 1,
      withdrawals: 1,
      savingsMoves: 0,
      unstamped: 0,
    })
    const rows = await transactions.all()
    expect(rows.map((r) => [r.txHash, r.networkId])).toEqual([
      ["0xA1", OLD],
      ["0xA2", OLD],
      ["0xA3", OLD],
    ])
    const unfinished = rows.find((r) => r.txHash === "0xA3")!
    expect(unfinished).toMatchObject({
      status: "failed",
      detailedStatus: QueueStatus.FAILED,
      failure: { code: "tx.failed" },
      endTime: 1_000,
    })
    expect(unfinished.operationId).toBeUndefined()
    expect("queueId" in unfinished).toBe(false)
    const imported = await loadRecords(sipaDeposits.view)
    expect(imported.map((d) => [d.sipaAddress, d.networkId])).toEqual([["0xsipa1", OLD]])
    expect(
      [...(await withdrawals.all())]
        .sort((a, b) => b.startTime - a.startTime)
        .map((w) => [w.localId, w.networkId]),
    ).toEqual([["w1", OLD]])
    expect(await storage.getItem(HISTORIC_ACTIVITY_IMPORTED_KEY)).toContain('"databases":["7"]')
  })

  it("runs once: a later call reads nothing", async () => {
    const { deps } = setup()
    const read = vi.fn(readOf([database("7", { rows: [row({})] })]))
    await importHistoricActivity({ ...deps([]), readOtherDatabases: read })
    expect(await importHistoricActivity({ ...deps([]), readOtherDatabases: read })).toBeNull()
    expect(read).toHaveBeenCalledTimes(1)
  })

  it("skips a row already here, keeps a row's own stamp, and leaves existing records alone", async () => {
    const { transactions, sipaDeposits, deps } = setup()
    await transactions.record(
      scannedRow({
        action: "receive",
        txHash: "0xa1",
        from: "0xbob",
        senderL2Address: "0xbob",
        to: ACCOUNT,
        token,
        amountAtomic: 5_000_000n,
        timestamp: 5,
        networkId: ACTIVE,
      }),
    )
    await sipaDeposits.adopt({ ...deposit({ amount: "1" }), networkId: ACTIVE })
    const db = database("7", {
      scanned: [OLD],
      rows: [row({ txHash: "0xA1" }), row({ txHash: "0xA2", networkId: "0xother" })],
      deposits: [deposit({ amount: "999" })],
    })

    const result = await importHistoricActivity(deps([db]))

    expect(result).toMatchObject({ transactions: 1, deposits: 0 })
    const rows = await transactions.all()
    expect(rows.map((r) => [r.txHash, r.networkId])).toEqual([
      ["0xa1", ACTIVE],
      ["0xA2", "0xother"],
    ])
    expect(await sipaDeposits.get("0xsipa1")).toMatchObject({ amount: "1", networkId: ACTIVE })
  })

  it("carries a settled Sky burn's Savings move into the moves store, unsettled ones as migrated", async () => {
    const { moves, deps } = setup()
    const skyMove = {
      direction: "in",
      factory: `0x${"fa".repeat(20)}`,
      recipientCommitment: `0x${"0c".repeat(32)}`,
      recoveryCommitment: `0x${"0d".repeat(32)}`,
      relayerTip: "2",
      nonce: `0x${"01".repeat(32)}`,
    } as const
    const move = (localId: string, extra: Partial<SavedSavingsMove> = {}) => ({
      withdrawalLocalId: localId,
      direction: "in" as const,
      escrow: `0x${"ee".repeat(20)}` as const,
      nonce: skyMove.nonce,
      recipientCommitment: skyMove.recipientCommitment,
      amount: "5",
      startTime: 1,
      ...extra,
    })
    const db = database("7", {
      scanned: [OLD],
      withdrawals: [
        withdrawal({ skyMove }),
        withdrawal({ localId: "w2", skyMove }),
        withdrawal({ localId: "w3", phase: "submitting", skyMove }),
        withdrawal({ localId: "w4" }),
        // Its move does not read: it is skipped, and the rest carried.
        withdrawal({ localId: "w5", skyMove }),
      ],
      savingsMoves: [
        move("w1", {
          deposit: { inboxIndex: "1", amount: "4", claimed: true, at: 2 },
          vault: { assets: "3" },
        }),
        move("w2"),
        move("w3"),
        move("w4"),
        { withdrawalLocalId: "w5", amount: "5" },
      ],
    })

    expect((await importHistoricActivity(deps([db])))?.savingsMoves).toBe(2)
    await moves.ready
    const byId = Object.fromEntries(moves.view.get().records.map((r) => [r.withdrawalLocalId, r]))
    expect(Object.keys(byId).sort()).toEqual(["w1", "w2"])
    expect(byId.w1).toMatchObject({
      holdingId: "fea-sky",
      rail: "skyEscrow",
      escrow: { factory: skyMove.factory, address: move("w1").escrow, tip: 2n },
      phase: "claimed",
      amount: 5n,
      assets: 3n,
      deposit: { inboxIndex: 1n, amount: 4n, at: 2 },
    })
    expect(byId.w2).toMatchObject({ phase: "migrated", endTime: 5_000 })
  })

  it("dedups link rows by link when they carry no hash", async () => {
    const { transactions, deps } = setup()
    const link = {
      action: "Pay To Email",
      emailPaymentAction: "Pay To Email",
      paylink: "https://l/1",
      token,
      timestamp: 1,
      status: "success",
    }
    const db = database("7", { scanned: [OLD], rows: [link, link] as unknown as Transaction[] })
    expect((await importHistoricActivity(deps([db])))?.transactions).toBe(1)
    expect(await transactions.all()).toHaveLength(1)
  })

  it("leaves deposits and withdrawals that name no single network, but still carries the rows", async () => {
    const { transactions, sipaDeposits, withdrawals, deps } = setup()
    const dbs = [
      database("7", {
        rows: [row({ txHash: "0xA1" })],
        deposits: [deposit({})],
        withdrawals: [withdrawal({})],
      }),
      database("8", {
        scanned: [OLD, "0xolder"],
        rows: [row({ txHash: "0xB1" })],
        deposits: [deposit({ sipaAddress: "0xsipa8", networkId: "0xolder" })],
        withdrawals: [withdrawal({ localId: "w8" })],
      }),
    ]

    const result = await importHistoricActivity(deps(dbs))

    expect(result).toEqual({
      databases: 2,
      transactions: 2,
      deposits: 1,
      withdrawals: 0,
      savingsMoves: 0,
      unstamped: 3,
    })
    const rows = await transactions.all()
    expect(rows.map((r) => [r.txHash, r.networkId])).toEqual([
      ["0xA1", undefined],
      ["0xB1", undefined],
    ])
    expect((await loadRecords(sipaDeposits.view)).map((d) => d.sipaAddress)).toEqual(["0xsipa8"])
    expect([...(await withdrawals.all())].sort((a, b) => b.startTime - a.startTime)).toEqual([])
  })

  it("imports retired Savings moves on a later boot when no Sky holding was read", async () => {
    const { storage, moves, deps } = setup()
    const skyMove = {
      direction: "in",
      factory: `0x${"fa".repeat(20)}`,
      recipientCommitment: `0x${"0c".repeat(32)}`,
      recoveryCommitment: `0x${"0d".repeat(32)}`,
      relayerTip: "2",
      nonce: `0x${"01".repeat(32)}`,
    } as const
    const db = database("7", {
      scanned: [OLD],
      withdrawals: [withdrawal({ skyMove })],
      savingsMoves: [
        {
          withdrawalLocalId: "w1",
          direction: "in",
          escrow: `0x${"ee".repeat(20)}`,
          nonce: skyMove.nonce,
          recipientCommitment: skyMove.recipientCommitment,
          amount: "5",
          startTime: 1,
        },
      ],
    })
    const { skyHolding: _sky, ...unheld } = deps([db])
    expect((await importHistoricActivity(unheld))?.savingsMoves).toBe(0)
    expect(await storage.getItem(HISTORIC_ACTIVITY_IMPORTED_KEY)).toBeNull()
    expect((await importHistoricActivity(deps([db])))?.savingsMoves).toBe(1)
    expect((await loadRecords(moves.view)).map((r) => r.withdrawalLocalId)).toEqual(["w1"])
    expect(await storage.getItem(HISTORIC_ACTIVITY_IMPORTED_KEY)).not.toBeNull()
  })

  it("a failed read leaves no marker", async () => {
    const { storage, deps } = setup()
    const failing = {
      ...deps([]),
      readOtherDatabases: () => Promise.reject(new Error("pool busy")),
    }
    await expect(importHistoricActivity(failing)).rejects.toThrow("pool busy")
    expect(await storage.getItem(HISTORIC_ACTIVITY_IMPORTED_KEY)).toBeNull()
  })

  it("an account switch stops the import before any write", async () => {
    const { storage, transactions, deps } = setup()
    const db = database("7", { scanned: [OLD], rows: [row({})] })
    await expect(importHistoricActivity(deps([db], () => false))).rejects.toThrow("account changed")
    expect(await transactions.all()).toEqual([])
    expect(await storage.getItem(HISTORIC_ACTIVITY_IMPORTED_KEY)).toBeNull()
  })

  it("reads a database no build split yet from its account blob, and prefers the split list", async () => {
    const { transactions, deps } = setup()
    const unsplit = retired("5", {
      [ACCOUNT_STORAGE_KEY]: JSON.stringify({
        address: "0xacc",
        transactions: [row({ txHash: "0xL1" }), null],
      }),
      [cursorKey(OLD)]: "1",
    })
    const split = retired("6", {
      [ACCOUNT_STORAGE_KEY]: JSON.stringify({ transactions: [row({ txHash: "0xSTALE" })] }),
      [TRANSACTIONS_STORAGE_KEY]: JSON.stringify([row({ txHash: "0xS1" })]),
    })

    expect((await importHistoricActivity(deps([unsplit, split])))?.transactions).toBe(2)
    expect((await transactions.all()).map((r) => r.txHash)).toEqual(["0xL1", "0xS1"])
  })

  it("reads the rows a database's activity store saved, ahead of its legacy copy", async () => {
    const { transactions, deps } = setup()
    const saved = { ...row({ txHash: "0xN1" }), id: "0xn1", amountAtomic: 7n, networkId: OLD }
    const db = retired("8", {
      "acct/meta/activity": "1",
      "acct/activity/0xn1": encodeRecord(saved),
      [TRANSACTIONS_STORAGE_KEY]: JSON.stringify([
        row({ txHash: "0xN1", status: "pending" }),
        row({ txHash: "0xL2", timestamp: 2_000 }),
      ]),
    })

    expect((await importHistoricActivity(deps([db])))?.transactions).toBe(2)
    expect((await transactions.all()).map((r) => [r.txHash, r.status, r.amountAtomic])).toEqual([
      ["0xN1", "success", 7n],
      ["0xL2", "success", 5_000_000n],
    ])
  })

  it("reads the deposits a database's deposit store saved, ahead of its legacy blob", async () => {
    const { sipaDeposits, deps } = setup()
    const db = retired("8", {
      "acct/sipaDeposits/0xsipa1": encodeRecord(deposit({ networkId: OLD })),
      "acct/sipaDeposits/0xsipa2": encodeRecord(
        deposit({ sipaAddress: "0xsipa2" as never, networkId: OLD }),
      ),
      [KEY_SIPA_DEPOSITS]: JSON.stringify({
        "0xsipa1": deposit({ phase: "sweeping", networkId: OLD }),
      }),
    })

    expect((await importHistoricActivity(deps([db])))?.deposits).toBe(2)
    expect((await sipaDeposits.get("0xsipa1"))?.phase).toBe("claimed")
    expect(await sipaDeposits.get("0xsipa2")).toBeDefined()
  })

  it("skips malformed values and rows with neither hash nor link", async () => {
    const { storage, deps } = setup()
    const db = retired("7", {
      [TRANSACTIONS_STORAGE_KEY]: JSON.stringify([row({ txHash: "" }), 3, null]),
      [KEY_SIPA_DEPOSITS]: "{not json",
      [KEY_WITHDRAWALS]: JSON.stringify([withdrawal({})]),
    })
    expect(await importHistoricActivity(deps([db]))).toEqual({
      databases: 1,
      transactions: 0,
      deposits: 0,
      withdrawals: 0,
      savingsMoves: 0,
      unstamped: 0,
    })
    expect(await storage.getItem(HISTORIC_ACTIVITY_IMPORTED_KEY)).not.toBeNull()
  })
})

describe("importHistoricActivity writes", () => {
  it("runs every write under holdSession", async () => {
    const { storage, transactions, deps } = setup()
    const db = database("7", { scanned: [OLD], rows: [row({})], deposits: [deposit({})] })
    let rowsWhenHeld = -1
    const holdSession = vi.fn(async <T>(fn: () => Promise<T>) => {
      rowsWhenHeld = (await transactions.all()).length
      return fn()
    })

    await importHistoricActivity({ ...deps([db]), holdSession })

    expect(holdSession).toHaveBeenCalledTimes(1)
    expect(rowsWhenHeld).toBe(0)
    expect(await transactions.all()).toHaveLength(1)
    expect(await storage.getItem(HISTORIC_ACTIVITY_IMPORTED_KEY)).not.toBeNull()
  })

  it("a record write that does not reach storage fails the import and leaves no marker", async () => {
    const { storage, sipaBackend, sipaDeposits, deps } = setup()
    await sipaDeposits.ready
    sipaBackend.failing.commits = true
    const db = database("7", { scanned: [OLD], rows: [row({})], deposits: [deposit({})] })

    await expect(importHistoricActivity(deps([db]))).rejects.toThrow()
    expect(await storage.getItem(HISTORIC_ACTIVITY_IMPORTED_KEY)).toBeNull()
  })
})

describe("importHistoricActivity from a source generation", () => {
  it("files a database held as entries under its own marker, beside this browser's import", async () => {
    const { storage, transactions, withdrawals, deps } = setup()
    const burn = "0x" + "b1".repeat(32)
    await withdrawals.create({
      ...withdrawal({ localId: "here", l2TxHash: burn as never }),
      networkId: OLD,
    })
    const db = database("7", {
      scanned: [OLD],
      rows: [row({})],
      withdrawals: [
        withdrawal({ localId: "rebuilt", l2TxHash: burn as never }),
        withdrawal({ localId: "other", l2TxHash: ("0x" + "b2".repeat(32)) as never }),
      ],
    })
    const key = `${HISTORIC_ACTIVITY_IMPORTED_KEY}/${OLD}/0xtoken`

    const result = await importHistoricActivity({ ...deps([db]), key })

    expect(result).toMatchObject({ transactions: 1, withdrawals: 1 })
    expect(
      withdrawals.list
        .get()
        .records.map((w) => w.localId)
        .sort(),
    ).toEqual(["here", "other"])
    expect((await transactions.all())[0]?.networkId).toBe(OLD)
    expect(await storage.getItem(key)).not.toBeNull()
    expect(await storage.getItem(HISTORIC_ACTIVITY_IMPORTED_KEY)).toBeNull()
    expect(await importHistoricActivity({ ...deps([db]), key })).toBeNull()
  })

  it("imports a short read's rows and leaves the marker for a full read", async () => {
    const { storage, transactions, deps } = setup()
    const db = { ...database("7", { scanned: [OLD], rows: [row({})] }), partial: true }
    const key = `${HISTORIC_ACTIVITY_IMPORTED_KEY}/${OLD}/0xtoken`

    expect(await importHistoricActivity({ ...deps([db]), key })).toMatchObject({ transactions: 1 })
    expect(await transactions.all()).toHaveLength(1)
    expect(await storage.getItem(key)).toBeNull()

    const full = database("7", { scanned: [OLD], rows: [row({})] })
    expect(await importHistoricActivity({ ...deps([full]), key })).toMatchObject({
      transactions: 0,
    })
    expect(await storage.getItem(key)).not.toBeNull()
  })

  it("names a held row's counterparty by the tag a later read verified", async () => {
    const { transactions, deps } = setup()
    const sender = "0x" + "5e".repeat(32)
    const recipient = "0x" + "7e".repeat(32)
    const send = row({ txHash: "0xA1", to: recipient })
    const receive = row({
      txHash: "0xA2",
      action: "receive",
      from: sender,
      senderL2Address: sender,
      to: ACCOUNT,
    })
    const untagged = database("7", { scanned: [OLD], rows: [send, receive] })
    await importHistoricActivity({ ...deps([untagged]), key: "first" })

    const tagged = database("7", {
      scanned: [OLD],
      rows: [
        { ...send, toTag: "bob" },
        { ...receive, from: "alice" },
      ],
    })
    const result = await importHistoricActivity({ ...deps([tagged]), key: "second" })

    expect(result).toMatchObject({ transactions: 0 })
    const rows = await transactions.all()
    expect(rows.find((r) => r.txHash === "0xA1")).toMatchObject({ to: recipient, toTag: "bob" })
    expect(rows.find((r) => r.txHash === "0xA2")).toMatchObject({
      from: "alice",
      senderL2Address: sender,
    })
  })

  it("keeps a held row's tag over a later read's address", async () => {
    const { transactions, deps } = setup()
    const sender = "0x" + "5e".repeat(32)
    const receive = row({
      txHash: "0xA2",
      action: "receive",
      from: "alice",
      senderL2Address: sender,
      to: ACCOUNT,
    })
    await importHistoricActivity({
      ...deps([database("7", { scanned: [OLD], rows: [receive] })]),
      key: "first",
    })
    await importHistoricActivity({
      ...deps([database("7", { scanned: [OLD], rows: [{ ...receive, from: sender }] })]),
      key: "second",
    })

    expect((await transactions.all())[0]).toMatchObject({ from: "alice" })
  })
})

describe("retiredSipaDeposit", () => {
  it("finds an unswept deposit the import skips, stamped with the database's network", () => {
    const unswept = deposit({ sipaAddress: "0xSIPA9", phase: "broadcast" })
    const db = database("7", { scanned: [OLD], deposits: [unswept] })

    expect(retiredSipaDeposit(db, "0xsipa9")).toEqual({ ...unswept, networkId: OLD })
    expect(retiredSipaDeposit(db, "0xother")).toBeNull()
  })

  it("returns null for a record whose network cannot be told", () => {
    const db = database("7", {
      scanned: [OLD, "0xolder"],
      deposits: [deposit({ phase: "broadcast" })],
    })

    expect(retiredSipaDeposit(db, "0xsipa1")).toBeNull()
  })
})

describe("scannedNetworks", () => {
  it("reads the networks off cursor keys in both layouts, with or without an endpoint scope", () => {
    const db = retired("7", {
      [cursorKey(OLD)]: "1",
      [`acct/transferScanCursor/0xnew/abc123/${ACCOUNT}`]: "2",
      [`acct/transferScanCursor//${ACCOUNT}`]: "3",
      "@obsidion/transfer-scan/joined/v1/0xother/0xacc": "4",
    })
    expect([...scannedNetworks(db)].sort()).toEqual(["0xnew", OLD].sort())
  })
})
