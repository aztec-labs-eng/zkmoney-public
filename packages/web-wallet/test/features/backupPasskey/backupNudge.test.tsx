/**
 * Guards: Home's backup card hides while a saved add does not read, its Not now is saved, and
 * Settings' card and badge show for a one-device passkey only.
 */
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Before any import evaluates the feature flags.
vi.hoisted(() => vi.stubEnv("VITE_BACKUP_PASSKEY_SETTINGS", "true"))

import {
  BackupNudge,
  BackupNudgeBadge,
  SettingsBackupNudge,
} from "../../../src/features/backupPasskey/BackupNudge/BackupNudge"
import { WebPasskeyIdentityMap } from "../../../src/platform/auth/WebPasskeyIdentityMap"
import { createBackupNudges, memoryBackend, openDatabase } from "@obsidion/front-core"
import { balancesOf } from "../../support/balances"
import { OWNER, sent, signedRecord, testRotations } from "../../support/backupAdd"
import { seedDeviceKeys, testCore } from "../../support/page"
import { openTestSession } from "../../support/session"

const KEY = "ab".repeat(64)
const DOLLAR = 10n ** 18n

describe("BackupNudge", () => {
  let root: Root | undefined
  let container: HTMLDivElement

  /** A session on the account's only passkey, one that may sync unless `oneDevice`. */
  async function signIn(oneDevice = false) {
    const map = new WebPasskeyIdentityMap(testCore().database, "localhost")
    await map.upsert({
      credentialId: "cred",
      l2Address: "0xacct",
      pubkey: KEY,
      isMskRoot: true,
      backupEligible: !oneDevice,
    })
    await seedDeviceKeys({ credentialId: "cred" })
  }

  /** A session over `backend`, the account's database. */
  const open = (backend = memoryBackend()) =>
    openTestSession({
      backupRotations: testRotations(backend),
      backupNudges: createBackupNudges({ db: openDatabase(backend) }),
      balances: balancesOf({ main: 150n * DOLLAR, known: true, readThisSession: true }),
    })

  async function show(node: ReactNode = <BackupNudge />) {
    await act(async () => root?.unmount())
    container?.remove()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root!.render(node))
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
  }

  const card = () => container.querySelector('[data-testid="backup-nudge"]')
  const badge = () => container.querySelector(".zkm-alert-badge")
  const settings = (
    <>
      <SettingsBackupNudge onAdd={() => {}} />
      <BackupNudgeBadge />
    </>
  )

  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
  })

  it("stays hidden while a saved add does not read, never reading it as none", async () => {
    await signIn()
    open()
    await show()
    expect(card()).not.toBeNull()

    const backend = memoryBackend()
    backend.entries.set(
      `acct/backupRotations/${OWNER.toLowerCase()}`,
      JSON.stringify({ ...signedRecord(), phase: "typo" }),
    )
    open(backend)
    await show()
    expect(card()).toBeNull()
  })

  it("shows a saved add's card at its step, which can't be put off", async () => {
    await signIn()
    const saved = [
      [signedRecord(), "resume"],
      [signedRecord({ phase: "funded", ...sent() }), "adding"],
    ] as const
    for (const [record, kind] of saved) {
      const backend = memoryBackend()
      await testRotations(backend).put(record)
      open(backend)
      await show()
      expect(card()?.getAttribute("data-kind")).toBe(kind)
      expect(card()?.querySelector(".zkm-nudge-card__dismiss")).toBeNull()
      // Only the step's title is announced, never the network card's countdown.
      expect(card()?.getAttribute("aria-live")).toBeNull()
      expect(card()?.querySelectorAll("[aria-live]")).toHaveLength(1)
    }
  })

  async function dismiss() {
    const button = card()?.querySelector(".zkm-nudge-card__dismiss")
    await act(async () => (button as HTMLButtonElement).click())
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
  }

  it("keeps the balance card put off in the next session", async () => {
    await signIn()
    const backend = memoryBackend()
    open(backend)
    await show()
    await dismiss()
    expect(card()).toBeNull()

    open(backend)
    await show()
    expect(card()).toBeNull()
  })

  it("puts a one-device passkey's card off for the session only", async () => {
    await signIn(true)
    const backend = memoryBackend()
    open(backend)
    await show()
    await dismiss()
    expect(card()).toBeNull()

    open(backend)
    await show()
    expect(card()).not.toBeNull()
  })

  it("shows Settings no card and no badge for a synced passkey", async () => {
    await signIn()
    open()
    await show(settings)
    expect(card()).toBeNull()
    expect(badge()).toBeNull()
  })

  it("shows Settings the card and the badge for a one-device passkey", async () => {
    await signIn(true)
    open()
    await show(settings)
    expect(card()).not.toBeNull()
    expect(badge()).not.toBeNull()
  })
})
