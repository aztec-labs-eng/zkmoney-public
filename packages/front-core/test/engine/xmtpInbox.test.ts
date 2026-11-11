/** What the device keeps about the account's XMTP inboxes; an older build's revoke stamps carry. */
import { describe, expect, it } from "vitest"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import { createXmtpInbox } from "../../src/engine/xmtpInbox"
import {
  LEGACY_INBOX_ID_PREFIX,
  LEGACY_REVOKED_AT_PREFIX,
} from "../../src/storageMigrations/xmtpInbox"

const NS = "obsidion.acct."
const ADDRESS = "0xAbC0000000000000000000000000000000000001"

const open = (entries = new Map<string, string>()) =>
  createXmtpInbox({ db: openDatabase(memoryBackend(entries)).scoped(NS) })

describe("the xmtpInbox storage migration", () => {
  it("carries each revoke stamp and drops one that does not read", async () => {
    const entries = new Map([
      [`${NS}${LEGACY_REVOKED_AT_PREFIX}inbox-a`, "1700000000000"],
      [`${NS}${LEGACY_REVOKED_AT_PREFIX}inbox-b`, "not a number"],
    ])
    const inbox = open(entries)
    expect(await inbox.revokedAtMs("inbox-a")).toBe(1_700_000_000_000)
    expect(await inbox.revokedAtMs("inbox-b")).toBeUndefined()
    expect(entries.get(`${NS}${LEGACY_REVOKED_AT_PREFIX}inbox-a`)).toBe("1700000000000")
  })

  it("carries the inbox-id cache, merged by inbox with its stamp, so a warm start stays warm", async () => {
    const entries = new Map([
      [`${NS}${LEGACY_INBOX_ID_PREFIX}${ADDRESS.toLowerCase()}`, "inbox-a"],
      [`${NS}${LEGACY_REVOKED_AT_PREFIX}inbox-a`, "1700000000000"],
    ])
    const inbox = open(entries)
    expect(await inbox.built(ADDRESS)).toBe(true)
    expect(await inbox.revokedAtMs("inbox-a")).toBe(1_700_000_000_000)
  })
})

describe("xmtpInbox", () => {
  it("knows the identity it built an installation for, in any case, across opens", async () => {
    const entries = new Map<string, string>()
    await open(entries).markBuilt(ADDRESS, "inbox-a")
    const inbox = open(entries)
    expect(await inbox.built(ADDRESS.toLowerCase())).toBe(true)
    expect(await inbox.built("0x" + "00".repeat(20))).toBe(false)
  })

  it("clears a stamp and keeps the inbox's identity", async () => {
    const inbox = open()
    await inbox.markBuilt(ADDRESS, "inbox-a")
    await inbox.setRevokedAtMs("inbox-a", 5)
    await inbox.setRevokedAtMs("inbox-a", undefined)
    expect(await inbox.revokedAtMs("inbox-a")).toBeUndefined()
    expect(await inbox.built(ADDRESS)).toBe(true)
  })
})
