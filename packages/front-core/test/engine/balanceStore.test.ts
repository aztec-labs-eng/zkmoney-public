// @vitest-environment node
import { describe, expect, it } from "vitest"
import { createBalanceStore, selectEntry, type BalanceEntry } from "../../src/engine/balances"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import { loadRecords } from "../../src/engine/persistentStore"
import { BALANCE_RECORDS_KEY } from "../../src/storageMigrations/balances"

const NS = "obsidion.acct."
const SCOPE = "sandbox:0xacct"
const OTHER = "0xportal/old/0xsource:0xacct"
const TOKEN = "0xtok"

const db = (entries: Map<string, string>) => openDatabase(memoryBackend(entries)).scoped(NS)
const balancesOver = (entries = new Map<string, string>()) => ({
  entries,
  store: createBalanceStore({ db: db(entries), now: () => 50 }),
})

describe("the balance anchor fence", () => {
  it.each([
    { name: "an older anchor loses", first: 10, second: 9, wrote: false, held: 1n },
    { name: "an equal anchor replaces", first: 10, second: 10, wrote: true, held: 2n },
    { name: "a newer anchor wins", first: 10, second: 11, wrote: true, held: 2n },
    { name: "a read with no anchor replaces", first: 10, second: undefined, wrote: true, held: 2n },
    {
      name: "a stored read with no anchor is replaced",
      first: undefined,
      second: 9,
      wrote: true,
      held: 2n,
    },
  ])("$name", async ({ first, second, wrote, held }) => {
    const { store } = balancesOver()
    expect(await store.write(SCOPE, TOKEN, 1n, first)).toBe(true)
    expect(await store.write(SCOPE, TOKEN, 2n, second)).toBe(wrote)
    expect(selectEntry(store.view.get(), SCOPE, TOKEN)?.atomic).toBe(held)
  })

  it("keeps the newer read when an older one is written before it commits", async () => {
    const { store, entries } = balancesOver()
    await store.ready
    const [newer, older] = await Promise.all([
      store.write(SCOPE, TOKEN, 2n, 11),
      store.write(SCOPE, TOKEN, 1n, 10),
    ])
    expect([newer, older]).toEqual([true, false])
    const reopened = balancesOver(entries).store
    await loadRecords(reopened.view)
    expect(selectEntry(reopened.view.get(), SCOPE, TOKEN)?.atomic).toBe(2n)
  })

  it("fences each scope apart", async () => {
    const { store } = balancesOver()
    await store.write(SCOPE, TOKEN, 1n, 10)
    expect(await store.write(OTHER, TOKEN, 2n, 9)).toBe(true)
    expect(selectEntry(store.view.get(), SCOPE, TOKEN)?.atomic).toBe(1n)
    expect(selectEntry(store.view.get(), OTHER, TOKEN)?.atomic).toBe(2n)
  })

  it("stamps the write, and dates it by the read when given", async () => {
    const { store } = balancesOver()
    await store.write(SCOPE, TOKEN, 1n, 10, 7)
    expect(selectEntry(store.view.get(), SCOPE, TOKEN)).toEqual({
      scope: SCOPE,
      token: TOKEN,
      atomic: 1n,
      anchor: 10,
      readAt: 7,
      updatedAt: 50,
    })
  })
})

describe("the balances storage migration", () => {
  const BLOB = NS + BALANCE_RECORDS_KEY
  const seeded = (blob: string) => new Map([[BLOB, blob]])

  it("opens empty when no blob is saved", async () => {
    const { store } = balancesOver()
    expect(await loadRecords(store.view)).toEqual([])
  })

  it("carries each read the blob holds, old-version scopes included", async () => {
    const blob = JSON.stringify({
      [`${SCOPE}:${TOKEN}`]: {
        scope: SCOPE,
        tokenAddress: TOKEN,
        balance: "5",
        anchorBlock: 10,
        updatedAt: 3,
        readAt: 2,
      },
      [`${OTHER}:${TOKEN}`]: { scope: OTHER, tokenAddress: TOKEN, balance: "7", updatedAt: 4 },
      bad: { scope: SCOPE, tokenAddress: "0xbad", balance: "1.5" },
    })
    const { store, entries } = balancesOver(seeded(blob))
    const carried: BalanceEntry[] = [
      { scope: OTHER, token: TOKEN, atomic: 7n, readAt: 4, updatedAt: 4 },
      { scope: SCOPE, token: TOKEN, atomic: 5n, anchor: 10, readAt: 2, updatedAt: 3 },
    ]
    expect(await loadRecords(store.view)).toEqual(carried)
    expect(entries.get(BLOB)).toBe(blob)
  })

  it.each([
    ["does not parse", "{not-json"],
    ["is empty", ""],
    ["is not a record map", JSON.stringify([1])],
  ])("opens empty, saves its version and keeps the bytes when the blob %s", async (_, blob) => {
    const { store, entries } = balancesOver(seeded(blob))
    expect(await loadRecords(store.view)).toEqual([])
    expect(entries.get(`${NS}acct/meta/balances`)).toBe("1")
    expect(entries.get(BLOB)).toBe(blob)
    expect(await store.write(SCOPE, TOKEN, 1n, 10)).toBe(true)
    expect(selectEntry(store.view.get(), SCOPE, TOKEN)?.atomic).toBe(1n)
    expect(entries.get(BLOB)).toBe(blob)
  })

  it("changes nothing on a second open", async () => {
    const blob = JSON.stringify({ a: { scope: SCOPE, tokenAddress: TOKEN, balance: "5" } })
    const { store, entries } = balancesOver(seeded(blob))
    await store.ready
    await store.write(SCOPE, TOKEN, 9n)
    const first = new Map(entries)
    const again = balancesOver(entries).store
    expect((await loadRecords(again.view)).map((e) => e.atomic)).toEqual([9n])
    expect(entries).toEqual(first)
  })
})
