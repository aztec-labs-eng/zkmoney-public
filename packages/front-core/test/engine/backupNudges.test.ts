/** The backup nudges' "Not now": the balance card's is saved, the one-device card's lasts a session. */
import { describe, expect, it } from "vitest"
import { createBackupNudges } from "../../src/engine/backupNudges"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import type { ReadonlyStore } from "../../src/engine/store"

const open = (entries: Map<string, string>) =>
  createBackupNudges({ db: openDatabase(memoryBackend(entries)).scoped("obsidion.acct.") })

/** The store's value once its read lands. */
function read<T>(store: ReadonlyStore<T | "unread">): Promise<T> {
  return new Promise((resolve) => {
    const settle = () => {
      const value = store.get()
      if (value === "unread") return
      off()
      resolve(value)
    }
    const off = store.subscribe(settle)
    settle()
  })
}

describe("createBackupNudges", () => {
  it("keeps the balance card's threshold for the next session, and the one-device card's for this one", async () => {
    const entries = new Map<string, string>()
    const nudges = open(entries)
    expect(await read(nudges.putOffAt)).toBeNull()
    await nudges.putOffUntilAbove(2n ** 70n)
    nudges.hideForSession()
    expect(nudges.hiddenForSession.get()).toBe(true)

    const next = open(entries)
    expect(await read(next.putOffAt)).toBe(2n ** 70n)
    expect(next.hiddenForSession.get()).toBe(false)
  })

  it("reads as unread, never as none, when it cannot be read", async () => {
    const backend = memoryBackend()
    backend.failing.reads = true
    const { putOffAt } = createBackupNudges({ db: openDatabase(backend).scoped("obsidion.acct.") })
    const off = putOffAt.subscribe(() => {})
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(putOffAt.get()).toBe("unread")
    off()
  })
})
