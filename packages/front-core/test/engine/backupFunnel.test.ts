/** The backup passkey funnel's marks: a step is reported once, across sessions. */
import { describe, expect, it } from "vitest"
import { createBackupFunnel, type BackupFunnelMarks } from "../../src/engine/backupFunnel"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"

const open = (entries: Map<string, string>) =>
  createBackupFunnel({ db: openDatabase(memoryBackend(entries)).scoped("obsidion.acct.") })

/** Reports `step` for attempt `a` unless its mark already holds it. */
const decide = (step: string) => (marks: BackupFunnelMarks) => {
  const mark = marks.a ?? { attemptId: "a", reported: [] }
  if (mark.reported.includes(step)) return { next: marks, events: [] }
  return {
    next: { a: { ...mark, reported: [...mark.reported, step], timed: { step, at: 1 } } },
    events: [step],
  }
}

describe("createBackupFunnel", () => {
  it("reports a step once, in this session and the next", async () => {
    const entries = new Map<string, string>()
    const funnel = open(entries)
    expect(await funnel.report(["a"], decide("signed"))).toEqual(["signed"])
    expect(await funnel.report(["a"], decide("signed"))).toEqual([])

    const next = open(entries)
    expect(await next.report(["a"], decide("signed"))).toEqual([])
    expect(await next.report(["a"], decide("funded"))).toEqual(["funded"])
  })
})
