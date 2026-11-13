// @vitest-environment node
// The backup entry shows its open links only once every read is in, and fails closed on any that
// failed: a move the replay missed would land after the switch, unclaimed.
import { describe, expect, it } from "vitest"
import { gatedLinks, type EntryReads } from "../../../src/features/backupPasskey/backupEntryGate"

const LINKS = { open: [] }
const reads = (over: Partial<EntryReads<typeof LINKS>> = {}): EntryReads<typeof LINKS> => ({
  links: LINKS,
  adopted: true,
  moves: { loaded: true, failed: false },
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
    ["a Sky burn has no move yet", { adopted: false }],
    ["the device has not replayed its moves", { synced: false }],
    ["the links are unread", { links: undefined }],
    ["the saved moves are unread", { moves: { loaded: false, failed: false } }],
    ["the withdrawals are unread", { withdrawalsHydrated: false }],
    ["the old-version holdings are unread", { holdingsPending: true }],
  ])("checks while %s", (_, over) => {
    expect(gatedLinks(reads(over))).toBe("checking")
  })

  it.each<[string, Partial<EntryReads<typeof LINKS>>]>([
    ["the saved moves do not read", { moves: { loaded: false, failed: true }, synced: false }],
    ["the links do not read", { links: "unreadable", synced: false }],
  ])("fails closed when %s, before any other read is in", (_, over) => {
    expect(gatedLinks(reads(over))).toBe("unreadable")
  })
})
