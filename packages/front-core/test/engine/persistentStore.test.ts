import { describe, expect, it, vi } from "vitest"
import { decodeRecord, encodeRecord, persistentStore } from "../../src/engine/persistentStore"
import { createMemoryKv, type KvOp } from "../../src/engine/kv"
import { diskKv } from "./diskKv"

type Row = { n: number; big?: bigint }

const spec = (over: Partial<Parameters<typeof persistentStore<Row>>[1]> = {}) => ({
  scope: "acct",
  name: "rows",
  version: 1,
  ...over,
})

describe("record codec", () => {
  it("keeps bigints exact", () => {
    const value = { big: 2n ** 200n, list: [1n], plain: { $bigint: 1, other: true } }
    expect(decodeRecord(encodeRecord(value))).toEqual(value)
  })
})

describe("persistentStore", () => {
  it("keeps one key per record and the version in meta", async () => {
    const entries = new Map<string, string>()
    const kv = createMemoryKv(entries)
    const rows = persistentStore<Row>(kv, spec())
    await rows.ready
    rows.put("a", { n: 1, big: 5n })
    expect(entries.get("acct/meta/rows")).toBe("1")
    expect(decodeRecord(entries.get("acct/rows/a")!)).toEqual({ n: 1, big: 5n })
    expect(persistentStore<Row>(kv, spec()).latest("a")).toEqual({ n: 1, big: 5n })
  })

  it("migrates once at open, in one transaction with the new version", async () => {
    const kv = createMemoryKv()
    const v1 = persistentStore<Row>(kv, spec())
    v1.put("a", { n: 1 })
    v1.put("b", { n: 2 })
    const migrate = vi.fn((from: number | undefined, saved: ReadonlyMap<string, unknown>) => ({
      records: [...saved]
        .filter(([id]) => id !== "b")
        .map(([id, r]) => [id, { n: (r as Row).n * 10 }] as const),
      ops: [["legacy", null]] as KvOp[],
    }))
    kv.setItem("legacy", "x")
    const commit = vi.spyOn(kv, "commitTransaction")
    const v2 = persistentStore<Row>(kv, spec({ version: 2, migrate }))
    await v2.ready
    expect(migrate).toHaveBeenCalledWith(1, expect.any(Map), kv)
    expect(commit).toHaveBeenCalledTimes(1)
    expect([...v2.get()]).toEqual([["a", { n: 10 }]])
    expect(kv.getItem("acct/rows/b")).toBeNull()
    expect(kv.getItem("legacy")).toBeNull()
    persistentStore<Row>(kv, spec({ version: 2, migrate }))
    expect(migrate).toHaveBeenCalledTimes(1)
  })

  it("refuses a version change it cannot migrate", () => {
    const kv = createMemoryKv()
    persistentStore<Row>(kv, spec())
    expect(() => persistentStore<Row>(kv, spec({ version: 2 }))).toThrow(/no migration/)
  })

  it("shows a write once it lands, and to latest at once", async () => {
    const disk = diskKv()
    const rows = persistentStore<Row>(disk.kv, spec())
    await rows.ready
    disk.hold(true)
    const row = { n: 1 }
    rows.put("a", row)
    expect(rows.latest("a")).toBe(row)
    expect(rows.get().has("a")).toBe(false)
    await disk.land()
    expect(rows.get().get("a")).toBe(row)
    rows.remove("a")
    expect(rows.latest("a")).toBeUndefined()
    expect(rows.get().has("a")).toBe(true)
    await disk.land()
    expect(rows.get().has("a")).toBe(false)
  })

  it("never shows a failed write, and latest drops it", async () => {
    const disk = diskKv()
    const rows = persistentStore<Row>(disk.kv, spec())
    await rows.ready
    rows.put("a", { n: 1 })
    await disk.land()
    const listener = vi.fn()
    rows.subscribe(listener)
    disk.fail(true)
    rows.put("a", { n: 2 })
    expect(rows.latest("a")).toEqual({ n: 2 })
    await disk.land()
    expect(rows.latest("a")).toEqual({ n: 1 })
    expect(listener).not.toHaveBeenCalled()
  })

  it("saves a batch's records with other keys in one transaction, shown together", async () => {
    const disk = diskKv()
    const rows = persistentStore<Row>(disk.kv, spec())
    await rows.ready
    const seen: number[] = []
    rows.subscribe(() => seen.push(rows.get().size))
    const commit = vi.fn()
    disk.kv.onCommit(commit)
    await disk.kv.batch(() => {
      rows.put("a", { n: 1 })
      rows.put("a", { n: 2 })
      rows.put("b", { n: 3 })
      disk.kv.setItem("cursor", "9")
    })
    expect(seen).toEqual([2])
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0][0]).toEqual([
      ["acct/rows/a", encodeRecord({ n: 1 })],
      ["acct/rows/a", encodeRecord({ n: 2 })],
      ["acct/rows/b", encodeRecord({ n: 3 })],
      ["cursor", "9"],
    ])
    expect(rows.get().get("a")).toEqual({ n: 2 })
  })

  it("keeps neither the records nor the keys of a failed batch, but keeps a later write", async () => {
    const disk = diskKv()
    const rows = persistentStore<Row>(disk.kv, spec())
    rows.put("kept", { n: 0 })
    await disk.land()
    disk.hold(true)
    disk.fail(true)
    const saving = disk.kv.batch(() => {
      rows.put("a", { n: 1 })
      rows.remove("kept")
      disk.kv.setItem("cursor", "9")
    })
    await disk.land()
    await expect(saving).rejects.toThrow("disk")
    disk.fail(false)
    rows.put("b", { n: 3 })
    await disk.land()
    expect(rows.latest("a")).toBeUndefined()
    expect(rows.latest("kept")).toEqual({ n: 0 })
    expect(disk.kv.getItem("cursor")).toBeNull()
    expect([...rows.get().keys()].sort()).toEqual(["b", "kept"])
  })

  it("keeps nothing of a batch whose write throws", () => {
    const kv = createMemoryKv()
    const rows = persistentStore<Row>(kv, spec())
    expect(() =>
      kv.batch(() => {
        rows.put("a", { n: 1 })
        throw new Error("boom")
      }),
    ).toThrow("boom")
    expect(rows.latest("a")).toBeUndefined()
    expect(rows.get().has("a")).toBe(false)
  })

  it("writes only changed records, and keeps a record's object while its text is unchanged", async () => {
    const kv = createMemoryKv()
    const rows = persistentStore<Row>(kv, spec())
    await rows.ready
    const setItem = vi.spyOn(kv, "setItem")
    rows.put("a", { n: 1 })
    const first = rows.get().get("a")
    const listener = vi.fn()
    rows.subscribe(listener)
    rows.put("a", { n: 1 })
    await kv.commitTransaction([["acct/rows/a", encodeRecord({ n: 1 })]])
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(listener).not.toHaveBeenCalled()
    expect(rows.latest("a")).toBe(first)
  })

  it("holds what was saved before the open, and a migration's records once it lands", async () => {
    const kv = createMemoryKv()
    persistentStore<Row>(kv, spec()).put("a", { n: 1 })
    expect(persistentStore<Row>(kv, spec()).get().get("a")).toEqual({ n: 1 })
    const disk = diskKv()
    disk.hold(true)
    const v2 = persistentStore<Row>(
      disk.kv,
      spec({ version: 2, migrate: () => ({ records: [["b", { n: 2 }]] }) }),
    )
    expect(v2.get().size).toBe(0)
    expect(v2.latest("b")).toEqual({ n: 2 })
    await disk.land()
    await v2.ready
    expect(v2.get().get("b")).toBe(v2.latest("b"))
  })
})
