import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { seedDeviceKeys, testCore, testPage } from "../../support/page"
import {
  createContacts,
  fixed,
  HISTORIC_ACTIVITY_IMPORTED_KEY,
  HISTORIC_CONTACTS_IMPORTED_KEY,
  memoryBackend,
  openDatabase,
  startRuntime,
  TRANSACTIONS_STORAGE_KEY,
  type Transaction,
} from "@obsidion/front-core"
import {
  historicImports,
  importHistoricActivityOnce,
} from "../../../src/features/migration/historicActivityImport"
import { activeNamespace, closeSession, switchSession } from "../../../src/session/session"
import { pageSessionDeps } from "../../../src/app/sessionDeps"
import { closeWalletStore, openWalletStore } from "../../../src/platform/storage/walletStorage"
import { WEB_STORAGE_PREFIX, webStorage } from "../../../src/platform/storage/WebStorageAdapter"
import { assignReads } from "../../support/fakeReads"
import { testWalletDbs } from "../../support/fakeWalletDb"
import { holdingsOf } from "../../support/holdings"
import { sessions } from "../../../../front-core/test/engine/taskTable"

const dbs = testWalletDbs()
const ROLLUP = "900"
const OLD_ROLLUP = "7"
const OLD_NETWORK = "0xold"
const CURSOR = `@obsidion/transfer-scan/cursor/v1/${OLD_NETWORK}/0xacc`

const scoped = (id: string, key: string) => `${WEB_STORAGE_PREFIX}${id}.${key}`

/** The active account, committed, as a booted wallet has it. */
const activate = (id: string) => seedDeviceKeys({ storageId: id })

const row = (txHash: string): Transaction =>
  ({
    action: "send",
    token: {
      name: "USDC",
      decimals: 6,
      logo: "",
      price: 1,
      symbol: "USDC",
      address: "0xt",
      amount: 1,
    },
    timestamp: 1,
    status: "success",
    txHash,
    from: "0xacc",
    to: "0xbob",
  } as Transaction)

// The setup's store is in memory, which has no other databases; a persistent one does.
beforeEach(async () => {
  await closeWalletStore()
  await openWalletStore(ROLLUP, { persistent: true })
})

describe("WebStorageAdapter.readOtherDatabases", () => {
  it("hands each other database to the reader, scoped to the active account", async () => {
    await activate("acct")
    const old = dbs.db(OLD_ROLLUP).state
    old.set(scoped("acct", "k"), "mine")
    old.set(scoped("other", "k"), "theirs")
    old.set(scoped("acct", "p/1"), "a")
    old.set(scoped("acct", "p/2"), "b")
    old.set(scoped("other", "p/3"), "c")
    dbs.db("8")

    const seen = await webStorage.readOtherDatabases((db) => [
      db.version,
      db.get("k"),
      db.keys("p/"),
    ])

    expect(seen).toEqual([
      [OLD_ROLLUP, "mine", ["p/1", "p/2"]],
      ["8", undefined, []],
    ])
  })

  it("fails the read when another document holds a database", async () => {
    await activate("acct")
    dbs.db(OLD_ROLLUP)
    const held = await dbs.open(OLD_ROLLUP, true)
    try {
      await expect(webStorage.readOtherDatabases((db) => db.version)).rejects.toThrow("busy")
    } finally {
      await held.close()
    }
  })
})

describe("importHistoricActivityOnce", () => {
  afterEach(() => closeSession())

  it("carries the account's rows from the retired rollup's database into this one, once", async () => {
    await activate("acct1")
    const page = testPage()
    assignReads(page.chain, { holdings: async () => holdingsOf() })
    const session = switchSession(activeNamespace(testCore().device), pageSessionDeps(page))
    const old = dbs.db(OLD_ROLLUP).state
    old.set(scoped("acct1", TRANSACTIONS_STORAGE_KEY), JSON.stringify([row("0xA1")]))
    old.set(scoped("acct1", CURSOR), "10")
    old.set(scoped("acct2", TRANSACTIONS_STORAGE_KEY), JSON.stringify([row("0xB1")]))

    const result = await importHistoricActivityOnce(session, "acct1")

    expect(result).toMatchObject({ databases: 1, transactions: 1 })
    await session.transfers.ready
    const rows = await session.transfers.all()
    expect(rows.map((r) => [r.txHash, r.networkId])).toEqual([["0xA1", OLD_NETWORK]])
    expect(await webStorage.getItem(HISTORIC_ACTIVITY_IMPORTED_KEY)).not.toBeNull()
    await expect(importHistoricActivityOnce(session, "acct1")).resolves.toBe(result)
  })
})

describe("historicImports", () => {
  afterEach(() => closeSession())

  it("carries the account's contacts from the retired rollup's book by default", async () => {
    await activate("acct1")
    const session = switchSession(activeNamespace(testCore().device), pageSessionDeps(testPage()))
    const alice = { name: "alice", address: `0x${"a5".repeat(32)}`, tag: "alice", verified: true }
    dbs.db(OLD_ROLLUP).state.set(scoped("acct1", "obsidion_contacts"), JSON.stringify([alice]))
    const contacts = createContacts({ db: openDatabase(memoryBackend()), now: () => Date.now() })
    const h = sessions(startRuntime)
    h.tasks.push(...historicImports(fixed("wallet", {}), { storageId: "acct1", contacts }, session))
    h.start()
    try {
      await vi.waitFor(async () =>
        expect(await webStorage.getItem(HISTORIC_CONTACTS_IMPORTED_KEY)).not.toBeNull(),
      )
    } finally {
      h.end()
    }
    expect((await contacts.all()).map((c) => c.tag)).toEqual(["alice"])
  })
})
