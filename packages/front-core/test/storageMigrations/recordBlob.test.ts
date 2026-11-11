import { describe, expect, it } from "vitest"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import { decodeRecord } from "../../src/engine/persistentStore"
import { carryRecordBlob } from "../../src/storageMigrations/recordBlob"

const KEY = "@obsidion/things/records"
const STORE = { prefix: "acct/things", id: (r: { id: string }) => r.id }
const toRecord = (value: unknown) =>
  typeof value === "object" && value && "id" in value && typeof value.id === "string"
    ? { id: value.id }
    : undefined
/** Fails closed: a value that is not a record keyed by its own id rejects the carry. */
const strict = (value: unknown, key: string) => {
  const record = toRecord(value)
  if (record?.id !== key) throw new Error(`bad record ${key}`)
  return record
}

/** Runs the carry in one write over `entries`, and reports the writes it committed. */
async function carry(
  entries: Map<string, string>,
  make: typeof strict = toRecord,
  unreadable?: "empty",
) {
  const backend = memoryBackend(entries)
  const applied: string[][] = []
  const apply = backend.apply.bind(backend)
  backend.apply = async (ops) => {
    applied.push(ops.map(([key]) => key))
    return apply(ops)
  }
  await openDatabase(backend).write((w) => carryRecordBlob(w, KEY, STORE, make, unreadable))
  return applied
}

describe("carryRecordBlob", () => {
  it("carries nothing without a blob", async () => {
    const entries = new Map<string, string>()
    await carry(entries)
    expect([...entries]).toEqual([])
  })

  it("puts each record it makes by its id in one write, skips the rest, and keeps the blob", async () => {
    const blob = JSON.stringify({ k1: { id: "a" }, k2: { id: 2 }, k3: null, k4: { id: "b" } })
    const entries = new Map([[KEY, blob]])
    expect(await carry(entries)).toEqual([["acct/things/a", "acct/things/b"]])
    expect(decodeRecord(entries.get("acct/things/a")!)).toEqual({ id: "a" })
    expect(entries.get(KEY)).toBe(blob)
  })

  it("hands each value its key, and a throw rejects the carry with nothing written", async () => {
    const good = JSON.stringify({ a: { id: "a" }, b: { id: "b" } })
    const goodEntries = new Map([[KEY, good]])
    expect(await carry(goodEntries, strict)).toEqual([["acct/things/a", "acct/things/b"]])

    const bad = JSON.stringify({ a: { id: "a" }, b: { id: "c" } })
    const entries = new Map([[KEY, bad]])
    await expect(carry(entries, strict)).rejects.toBeDefined()
    expect([...entries]).toEqual([[KEY, bad]])
  })

  it.each([
    ["does not parse", "{not-json"],
    ["is empty", ""],
    ["is a list", "[]"],
    ["is null", "null"],
    ["is a string", JSON.stringify("records")],
  ])("rejects, writing nothing, when the blob %s", async (_, blob) => {
    const entries = new Map([[KEY, blob]])
    await expect(carry(entries)).rejects.toBeDefined()
    expect([...entries]).toEqual([[KEY, blob]])
  })

  it("carries nothing and keeps the bytes for an unreadable blob when asked to open empty", async () => {
    const entries = new Map([[KEY, "{not-json"]])
    expect(await carry(entries, toRecord, "empty")).toEqual([])
    expect([...entries]).toEqual([[KEY, "{not-json"]])
  })
})
