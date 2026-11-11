// @vitest-environment node
// The backup entry shows its open links only once every read is in, and fails closed on any that
// failed: a Savings move the replay missed would land after the switch, unclaimed.
import { describe, expect, it } from "vitest"
import { gatedLinks, type EntryReads } from "../../../src/features/backupPasskey/backupEntryGate"

const LINKS = { open: [] }
const reads = (over: Partial<EntryReads<typeof LINKS>> = {}): EntryReads<typeof LINKS> => ({
  links: LINKS,
  replayed: true,
  adopted: true,
  savingsMoves: { loaded: true, failed: false },
  withdrawalsHydrated: true,
  holdingsPending: false,
  synced: true,
  ...over,
})

describe("gatedLinks", () => {
  it("gives the links once every read is in", () => {
    expect(gatedLinks(reads())).toBe(LINKS)
  })

  it.each<[string, Partial<EntryReads<typeof LINKS>>]>([
    ["the moves replay is running", { replayed: undefined }],
    ["a rebuilt Savings burn has no move yet", { adopted: false }],
    ["the device has not synced", { synced: false }],
    ["the links are unread", { links: undefined }],
    ["the saved moves are unread", { savingsMoves: { loaded: false, failed: false } }],
    ["the withdrawals are unread", { withdrawalsHydrated: false }],
    ["the old-version holdings are unread", { holdingsPending: true }],
  ])("checks while %s", (_, over) => {
    expect(gatedLinks(reads(over))).toBe("checking")
  })

  it.each<[string, Partial<EntryReads<typeof LINKS>>]>([
    ["the moves replay failed", { replayed: false, synced: false }],
    ["the saved moves do not read", { savingsMoves: { loaded: false, failed: true } }],
    ["the links do not read", { links: "unreadable", replayed: undefined }],
  ])("fails closed when %s, before any other read is in", (_, over) => {
    expect(gatedLinks(reads(over))).toBe("unreadable")
  })
})
