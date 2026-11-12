/** What a saved backup rotation that fails its check tells telemetry, before the read fails. */
import { describe, expect, it } from "vitest"
import {
  WalletError,
  createBackupRotations,
  loadRecords,
  memoryBackend,
  openDatabase,
  type BackupRotationRecord,
  type UnreadableRotationRow,
} from "../../src/index.js"
import { OWNER } from "../__test-helpers__/backupRotation"

const KEY = OWNER.toLowerCase()
const NS = "obsidion.acct."
const LEGACY = `${NS}obsidion_backup_rotation`
const ROW = `${NS}acct/backupRotations/${KEY}`

function rotationsOver(entries: Map<string, string>, hook?: (row: UnreadableRotationRow) => void) {
  const heard: UnreadableRotationRow[] = []
  const store = createBackupRotations({
    db: openDatabase(memoryBackend(entries)).scoped(NS),
    onUnreadable: (row) => {
      heard.push(row)
      hook?.(row)
    },
  })
  return { store, heard }
}

/** A store opened once, so the next open reads `value` as a saved row with nothing to carry. */
async function savedRow(value: unknown) {
  const entries = new Map<string, string>()
  await rotationsOver(entries).store.ready
  entries.set(ROW, JSON.stringify(value))
  return entries
}

describe("a saved backup rotation that fails its check", () => {
  it.each<[unknown, UnreadableRotationRow]>([
    [
      { owner: KEY, phase: "funded", fundings: [{ outcome: "pending" }, { outcome: "mined" }] },
      { phase: "funded", outcome: "mined", unswept: false },
    ],
    [
      { owner: KEY, phase: "installed", unswept: true, fundings: [] },
      { phase: "installed", outcome: "none", unswept: true },
    ],
    [
      { owner: KEY, phase: "installed", unswept: "true", fundings: [] },
      { phase: "installed", outcome: "none", unswept: undefined },
    ],
    [
      { owner: KEY, phase: "typo", fundings: [] },
      { phase: "unknown", outcome: "none", unswept: false },
    ],
    [
      { owner: KEY, phase: "signed" },
      { phase: "signed", outcome: "unknown", unswept: false },
    ],
    [
      { owner: KEY, phase: "swept", fundings: [{ outcome: "lost" }] },
      { phase: "swept", outcome: "unknown", unswept: false },
    ],
    [null, { phase: "unknown", outcome: "unknown", unswept: false }],
  ])("reports %j by what it tells of funds", async (value, row) => {
    const { store, heard } = rotationsOver(await savedRow(value))
    await expect(loadRecords(store.view)).rejects.toBeDefined()
    expect(heard).toEqual([row])
  })

  it("reports a damaged row of the older builds' blob as its carry fails", async () => {
    const text = JSON.stringify({ [KEY]: { owner: KEY, phase: "published", fundings: [] } })
    const { store, heard } = rotationsOver(new Map([[LEGACY, text]]))
    await expect(store.ready).rejects.toBeDefined()
    expect(heard).toEqual([{ phase: "published", outcome: "none", unswept: false }])
  })

  it("fails the read with the damaged-row error when the hook throws", async () => {
    const text = JSON.stringify({ [KEY]: null })
    const { store, heard } = rotationsOver(new Map([[LEGACY, text]]), () => {
      throw new WalletError("invariant", "hook")
    })
    await expect(store.ready).rejects.toMatchObject({ code: "unknown" })
    expect(heard).toHaveLength(1)
  })

  it("reports nothing for a write the check refuses", async () => {
    const { store, heard } = rotationsOver(new Map())
    const bad = { owner: KEY, phase: "funded" } as unknown as BackupRotationRecord
    await expect(store.put(bad)).rejects.toBeDefined()
    expect(await loadRecords(store.view)).toEqual([])
    expect(heard).toEqual([])
  })
})
