/** The inbox driver's cursors: one record per conversation, an older build's map carried at open. */
import { describe, expect, it } from "vitest"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import { createXmtpCursors } from "../../src/engine/xmtpCursors"
import { LEGACY_XMTP_CURSORS_KEY } from "../../src/storageMigrations/xmtpCursors"

const NS = "obsidion.acct."
const LEGACY = NS + LEGACY_XMTP_CURSORS_KEY
const BIG = 2n ** 60n + 1n

/** A cursor store over `entries`, on the account namespace; `applied` lists each commit's keys. */
function open(entries = new Map<string, string>()) {
  const backend = memoryBackend(entries)
  const applied: string[][] = []
  const apply = backend.apply.bind(backend)
  backend.apply = async (ops) => {
    applied.push(ops.map(([key]) => key.slice(NS.length)))
    return apply(ops)
  }
  const cursors = createXmtpCursors({ db: openDatabase(backend).scoped(NS) })
  return { entries, cursors, applied }
}

const seeded = (map: unknown) =>
  new Map([[LEGACY, typeof map === "string" ? map : JSON.stringify(map)]])
const records = (entries: Map<string, string>) =>
  [...entries.keys()].filter((key) => key.startsWith(`${NS}acct/xmtpCursors/`)).sort()

describe("the xmtpCursors storage migration", () => {
  it("carries every cursor, the installation and the resume point, and keeps the map", async () => {
    const map = {
      installationId: "install-A",
      cursors: { convA: 200, convB: BIG.toString() },
      resumeConversationId: "convC",
    }
    const { cursors, entries } = open(seeded(map))
    expect(await cursors.load()).toEqual({
      installationId: "install-A",
      cursors: { convA: 200n, convB: BIG },
      resumeConversationId: "convC",
    })
    expect(records(entries)).toEqual(
      ["convA", "convB", "convC"].map((c) => `${NS}acct/xmtpCursors/${c}`),
    )
    expect(entries.get(LEGACY)).toBe(JSON.stringify(map))
  })

  it("carries once: a later open reads its records, not the map", async () => {
    const entries = seeded({ installationId: "install-A", cursors: { convA: 200 } })
    await open(entries).cursors.load()
    entries.set(LEGACY, JSON.stringify({ installationId: "install-B", cursors: { convA: 5 } }))
    const reopened = open(entries)
    expect(await reopened.cursors.load()).toMatchObject({
      installationId: "install-A",
      cursors: { convA: 200n },
    })
    expect(reopened.applied).toEqual([])
  })

  it("drops a cursor that does not read, so only its conversation replays", async () => {
    const { cursors } = open(seeded({ installationId: "i", cursors: { convA: 1.5, convB: 7 } }))
    expect((await cursors.load()).cursors).toEqual({ convB: 7n })
  })

  it.each([
    ["does not parse", "{not-json"],
    ["holds no cursors", JSON.stringify({ installationId: "install-A" })],
  ])("fails the open and keeps the bytes when the map %s", async (_, map) => {
    const { cursors, entries } = open(seeded(map))
    await expect(cursors.load()).rejects.toBeDefined()
    await expect(
      cursors.save({ installationId: "i", cursors: { convA: 1n } }),
    ).rejects.toBeDefined()
    expect(entries.get(LEGACY)).toBe(map)
    expect(records(entries)).toEqual([])
  })
})

describe("xmtpCursors", () => {
  it("writes only the cursors that moved, and removes the ones a reset dropped", async () => {
    const { cursors, entries, applied } = open()
    await cursors.save({ installationId: "i", cursors: { convA: 1n, convB: 2n } })
    await cursors.save({ installationId: "i", cursors: { convA: 3n, convB: 2n } })
    expect(applied.at(-1)).toEqual(["acct/xmtpCursors/convA"])
    await cursors.save({ installationId: "j", cursors: {} })
    expect(records(entries)).toEqual([])
    expect((await open(entries).cursors.load()).cursors).toEqual({})
  })
})
