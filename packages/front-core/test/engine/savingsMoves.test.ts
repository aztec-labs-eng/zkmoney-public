import { describe, expect, it } from "vitest"
import {
  createSavingsMoves,
  encodeRecord,
  memoryBackend,
  noteRefundedSavingsMoves,
  openDatabase,
  retiredDatabaseOf,
  storedSavingsMoves,
  type DatabaseBackend,
  type SavingsMoveRecord,
} from "../../src/index.js"
import { KEY_SAVINGS_MOVES } from "../../src/storageMigrations/savingsMoves"

const NS = "obsidion.acct."
const LEGACY = `${NS}${KEY_SAVINGS_MOVES}`
const TO = `0x${"7".repeat(40)}` as const
const TX = `0x${"ab".repeat(32)}` as const

const move = (over: Partial<SavingsMoveRecord> = {}): SavingsMoveRecord => ({
  direction: "in",
  withdrawalLocalId: "W1",
  escrow: `0x${"e".repeat(40)}`,
  nonce: `0x${"1".repeat(64)}`,
  recipientCommitment: `0x${"2".repeat(64)}`,
  amount: "100",
  startTime: 1_000,
  ...over,
})

const blob = (...moves: unknown[]) =>
  JSON.stringify(
    Object.fromEntries(moves.map((m, i) => [(m as SavingsMoveRecord)?.withdrawalLocalId ?? i, m])),
  )

function movesOver(
  entries = new Map<string, string>(),
  backend: DatabaseBackend = memoryBackend(entries),
) {
  return createSavingsMoves({ db: openDatabase(backend).scoped(NS) })
}

const savedKeys = (entries: Map<string, string>) =>
  [...entries.keys()].filter((key) => key.startsWith(`${NS}acct/savingsMoves/`))

describe("Savings moves", () => {
  it("carries every move of the blob as saved, its retired and recovered marks included", async () => {
    const retired = move({
      withdrawalLocalId: "W2",
      startTime: 2_000,
      retired: true,
      deposit: { inboxIndex: "5", amount: "100", claimed: true },
      recovered: { to: TO, txHashes: [TX] },
    })
    const entries = new Map([[LEGACY, blob(move(), retired)]])
    const moves = movesOver(entries)

    expect(await moves.all()).toEqual(expect.arrayContaining([move(), retired]))
    expect(await moves.get("w2")).toEqual(retired)
    expect(entries.get(LEGACY)).toBe(blob(move(), retired))
  })

  it.each([
    ["a blob that does not parse", "{"],
    ["a blob that is not an object", "[]"],
    ["a move without its key", blob({ ...move(), withdrawalLocalId: undefined })],
    ["a move with no direction", blob({ ...move(), direction: "sideways" })],
    ["a move with no start", blob({ ...move(), startTime: "soon" })],
  ])("fails the open on %s, writing nothing and keeping the bytes", async (_, raw) => {
    const entries = new Map([[LEGACY, raw]])
    const moves = movesOver(entries)

    await expect(moves.ready).rejects.toThrow()
    await expect(moves.all()).rejects.toThrow()
    await expect(moves.get("W1")).rejects.toThrow()
    await expect(moves.put(move())).rejects.toThrow()
    expect(savedKeys(entries)).toEqual([])
    expect(entries.get(LEGACY)).toBe(raw)
  })

  it("fails the load on a saved move that does not read", async () => {
    const entries = new Map([
      [`${NS}acct/savingsMoves/w1`, encodeRecord({ withdrawalLocalId: "W1" })],
    ])
    const moves = movesOver(entries)
    await expect(moves.ready).resolves.toBeUndefined()

    await expect(moves.all()).rejects.toThrow()
    await expect(moves.update("W1", () => move())).rejects.toThrow()
    expect(entries.get(`${NS}acct/savingsMoves/w1`)).toBe(encodeRecord({ withdrawalLocalId: "W1" }))
  })

  it("resolves a write only once it is committed, and keeps it across a reopen", async () => {
    const entries = new Map<string, string>()
    const inner = memoryBackend(entries)
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let gate = false
    const backend: DatabaseBackend = {
      ...inner,
      apply: async (ops) => {
        if (gate) await held
        return inner.apply(ops)
      },
    }
    const moves = movesOver(entries, backend)
    await moves.ready
    gate = true

    let done = false
    const put = moves.put(move()).then(() => (done = true))
    await new Promise((r) => setTimeout(r, 0))
    expect(done).toBe(false)
    expect(savedKeys(entries)).toEqual([])
    release()
    await put
    expect(savedKeys(entries)).toEqual([`${NS}acct/savingsMoves/w1`])
    expect(await movesOver(entries).get("W1")).toEqual(move())
  })

  it("keeps a move removed while a change to it was decided", async () => {
    const moves = movesOver()
    await moves.put(move())
    await moves.remove("W1")

    expect(await moves.update("W1", (current) => current && { ...current, amount: "1" })).toBeNull()
    expect(await moves.all()).toEqual([])
  })

  it("marks recovered only the retired move whose deposit the refund returned", async () => {
    const deposit = { inboxIndex: "5", amount: "100", claimed: true }
    const moves = movesOver()
    await moves.put(move({ retired: true, deposit }))
    await moves.put(
      move({ withdrawalLocalId: "W2", retired: true, deposit: { ...deposit, amount: "9" } }),
    )
    await moves.put(move({ withdrawalLocalId: "W3", deposit }))

    await noteRefundedSavingsMoves(moves, [{ leafIndex: "5", amount: "100" }], TO, TX)

    expect((await moves.get("W1"))?.recovered).toEqual({ to: TO, txHashes: [TX] })
    expect((await moves.get("W2"))?.recovered).toBeUndefined()
    expect((await moves.get("W3"))?.recovered).toBeUndefined()
  })
})

describe("storedSavingsMoves", () => {
  it("reads a retired database's moves in either layout, the store's over the blob's", () => {
    const db = retiredDatabaseOf("7", {
      "acct/savingsMoves/w1": encodeRecord(move({ amount: "store" })),
      [KEY_SAVINGS_MOVES]: blob(move({ amount: "blob" }), move({ withdrawalLocalId: "W2" })),
    })

    expect(storedSavingsMoves(db)).toEqual([
      move({ amount: "store" }),
      move({ withdrawalLocalId: "W2" }),
    ])
  })

  it("reads nothing from a blob that does not parse", () => {
    expect(storedSavingsMoves(retiredDatabaseOf("7", { [KEY_SAVINGS_MOVES]: "{" }))).toEqual([])
  })
})
