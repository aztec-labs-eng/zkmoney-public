/**
 * Home's reminder to add a backup passkey: which accounts see it, and how it steps aside for an add
 * in progress or a backup the chain lists, and hides for the rest of the page session. The tap that
 * opens the add is pinned in the Passkeys sheet's tests, which stand in for its chain reads.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Before any import evaluates the feature flags.
vi.hoisted(() => vi.stubEnv("VITE_BACKUP_PASSKEY_SETTINGS", "true"))

import { BackupReminderLine } from "../../../src/features/backupPasskey/BackupReminderLine/BackupReminderLine"
import {
  backupReminderApplies,
  backupReminderDismissed,
  backupSeenOnChain,
  type BackupReminderFacts,
} from "../../../src/features/backupPasskey/backupReminder"
import {
  getBackupRotationStore,
  rereadBackupRotation,
  resetBackupRotationStoreForTests,
} from "../../../src/features/backupPasskey/backupRotationStore"
import { WebPasskeyIdentityMap } from "../../../src/platform/auth/WebPasskeyIdentityMap"
import { webStorage } from "../../../src/platform/storage/WebStorageAdapter"
import { signedRecord } from "../../support/backupAdd"
import { seedDeviceKeys, testCore } from "../../support/page"
import { openTestSession } from "../../support/session"

const KEY = "ab".repeat(64)
const BACKUP_KEY = "cd".repeat(64)

const facts = (over: Partial<BackupReminderFacts> = {}): BackupReminderFacts => ({
  enabled: true,
  record: { backupEligible: false },
  noAddSaved: true,
  backupOnChain: false,
  dismissed: false,
  ...over,
})

describe("backupReminderApplies", () => {
  it("a one-key account whose passkey lives on one device is reminded", () => {
    expect(backupReminderApplies(facts())).toBe(true)
    expect(
      backupReminderApplies(facts({ record: { backupEligible: false, passkeySet: [KEY] } })),
    ).toBe(true)
  })

  it("a synced passkey, or an account with a backup, never is", () => {
    expect(backupReminderApplies(facts({ record: { backupEligible: true } }))).toBe(false)
    const twoKeys = { backupEligible: false, passkeySet: [KEY, BACKUP_KEY] }
    expect(backupReminderApplies(facts({ record: twoKeys }))).toBe(false)
    const backup = { account: "0xowner", envelope: "0x01" }
    expect(backupReminderApplies(facts({ record: { backupEligible: false, backup } }))).toBe(false)
  })

  it("a record with no flag counts by the creation's security-key verdict", () => {
    expect(backupReminderApplies(facts({ record: { securityKey: true } }))).toBe(true)
    expect(backupReminderApplies(facts({ record: {} }))).toBe(false)
    expect(
      backupReminderApplies(facts({ record: { securityKey: true, backupEligible: true } })),
    ).toBe(false)
  })

  it("nothing shows with the add off, dismissed, an add saved, a second key on chain, or no record", () => {
    expect(backupReminderApplies(facts({ enabled: false }))).toBe(false)
    expect(backupReminderApplies(facts({ dismissed: true }))).toBe(false)
    expect(backupReminderApplies(facts({ noAddSaved: false }))).toBe(false)
    expect(backupReminderApplies(facts({ backupOnChain: true }))).toBe(false)
    expect(backupReminderApplies(facts({ record: undefined }))).toBe(false)
  })
})

describe("BackupReminderLine", () => {
  let root: Root | undefined
  let container: HTMLDivElement

  /** A session on a passkey with `flag`; `passkeySet` names the account's keys. */
  async function session(flag: boolean, passkeySet?: string[], credentialId = "cred") {
    const map = new WebPasskeyIdentityMap(testCore().database, "localhost")
    await map.upsert({
      credentialId,
      l2Address: "0xacct",
      pubkey: KEY,
      isMskRoot: true,
      backupEligible: flag,
      ...(passkeySet ? { passkeySet } : {}),
    })
    await seedDeviceKeys({ credentialId })
  }

  async function show() {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root!.render(<BackupReminderLine />))
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
  }

  const line = () => container.querySelector('[data-testid="backup-reminder-line"]')
  const press = (id: string) =>
    act(async () => container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click())

  beforeEach(() => {
    localStorage.clear()
    openTestSession()
    resetBackupRotationStoreForTests()
    backupReminderDismissed.set(false)
    backupSeenOnChain.set(false)
  })

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
  })

  it("reminds a device-bound one-key account", async () => {
    await session(false)
    await show()
    expect(line()).not.toBeNull()
  })

  it("says nothing to a synced passkey or an account that has its backup", async () => {
    await session(true)
    await show()
    expect(line()).toBeNull()
    await act(async () => root!.unmount())
    root = undefined

    await session(false, [KEY, BACKUP_KEY], "second")
    await show()
    expect(line()).toBeNull()
  })

  it("steps aside once an add is saved", async () => {
    await session(false)
    await show()
    await act(async () => getBackupRotationStore().put(signedRecord()))
    expect(line()).toBeNull()
  })

  it("waits while the saved adds cannot be read, and shows once a read finds none", async () => {
    await session(false)
    const read = vi.spyOn(webStorage, "getItem").mockRejectedValueOnce(new Error("locked"))
    await show()
    expect(line()).toBeNull()
    read.mockRestore()
    await act(async () => rereadBackupRotation())
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(line()).not.toBeNull()
  })

  it("steps aside once the Passkeys sheet reads a second key on the account", async () => {
    await session(false)
    await show()
    await act(async () => backupSeenOnChain.set(true))
    expect(line()).toBeNull()
  })

  it("not now hides it for the page session; a new page shows it again", async () => {
    await session(false)
    await show()
    await press("backup-reminder-dismiss")
    expect(line()).toBeNull()
    await act(async () => backupReminderDismissed.set(false))
    expect(line()).not.toBeNull()
  })
})
