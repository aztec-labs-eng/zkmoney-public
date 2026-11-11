/** A scan's cursor moves under `acct/` on its first read; the older build's key is never written. */
import { describe, expect, it } from "vitest"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import { carriedScanCursor } from "../../src/storageMigrations/scanCursors"

const KEY = "acct/transferScanCursor/net/0xme"
const OLDER = "@obsidion/transfer-scan/cursor/v1/net/0xme"

function database(entries: [string, string][]) {
  const backend = memoryBackend()
  for (const [key, value] of entries) backend.entries.set(key, value)
  const applied: string[][] = []
  const apply = backend.apply.bind(backend)
  backend.apply = async (ops) => {
    applied.push(ops.map(([key]) => key))
    return apply(ops)
  }
  return { backend, applied, db: openDatabase(backend) }
}

describe("carriedScanCursor", () => {
  it("copies the older cursor to its key in one write, and reads the key after", async () => {
    const { backend, applied, db } = database([[OLDER, "42"]])
    expect(await carriedScanCursor(db, KEY, OLDER)).toBe("42")
    expect(applied).toEqual([[KEY]])
    expect(backend.entries.get(OLDER)).toBe("42")

    backend.entries.set(OLDER, "7")
    expect(await carriedScanCursor(db, KEY, OLDER)).toBe("42")
    expect(applied).toHaveLength(1)
  })

  it("writes nothing when there is nothing to carry", async () => {
    const { applied, db } = database([])
    expect(await carriedScanCursor(db, KEY, OLDER)).toBeUndefined()
    expect(applied).toEqual([])
  })
})
