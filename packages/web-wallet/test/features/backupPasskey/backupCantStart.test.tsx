/** Guards: B1, B3 and B4 show what holds the add and what clears it. */
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Before any import evaluates the feature flags.
vi.hoisted(() => vi.stubEnv("VITE_BACKUP_PASSKEY_SETTINGS", "true"))

import { fmt } from "../../../src/lib/fmt"
import { entryBlocks } from "../../../src/features/backupPasskey/backupPasskeyEntry"
import type { BackupActions, BackupKey } from "../../../src/features/backupPasskey/backupScreen"
import { BlockedScreen } from "../../../src/features/backupPasskey/screens/BlockedScreen/BlockedScreen"
import blockedCopy from "../../../src/features/backupPasskey/screens/BlockedScreen/BlockedScreen.copy"
import { LowBalanceScreen } from "../../../src/features/backupPasskey/screens/LowBalanceScreen/LowBalanceScreen"
import lowCopy from "../../../src/features/backupPasskey/screens/LowBalanceScreen/LowBalanceScreen.copy"
import { FirstPasskeyScreen } from "../../../src/features/backupPasskey/screens/FirstPasskeyScreen/FirstPasskeyScreen"
import firstCopy from "../../../src/features/backupPasskey/screens/FirstPasskeyScreen/FirstPasskeyScreen.copy"
import { UnreadableScreen } from "../../../src/features/backupPasskey/screens/UnreadableScreen/UnreadableScreen"
import unreadableCopy from "../../../src/features/backupPasskey/screens/UnreadableScreen/UnreadableScreen.copy"
import { HIDDEN_BALANCE } from "../../../src/ui/format"
import { ENTRY_READY } from "../../support/backupAdd"
import { seedDeviceKeys } from "../../support/page"
import { openTestSession } from "../../support/session"

const DAI = 10n ** 18n

const noop = () => undefined
const actions = (act?: BackupActions["act"]): BackupActions => ({
  add: noop,
  pick: noop,
  start: noop,
  approve: noop,
  fund: noop,
  approveMove: noop,
  retryMove: noop,
  check: noop,
  cancel: noop,
  askCancel: noop,
  recover: noop,
  finish: noop,
  dismiss: noop,
  retryRead: noop,
  ...(act && { act }),
})

let root: Root | undefined
let container: HTMLDivElement

async function show(node: ReactNode) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(node))
}

async function hide() {
  await act(async () => root?.unmount())
  root = undefined
  container?.remove()
}

beforeEach(() => {
  openTestSession()
})
afterEach(hide)

const text = () => container.textContent ?? ""
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === label)
const rows = () => container.querySelectorAll(".zkm-checklist-row")
/** A balance of 0.80 short of a 2.0551 funding that gives 1.5004 back. */
const LOW = {
  id: "lowBalance",
  funding: { sent: (20551n * DAI) / 10000n, credited: (15004n * DAI) / 10000n },
  have: (8n * DAI) / 10n,
} as const

describe("B1, what holds the add", () => {
  it("lists every open item under the ticked registration, with a link where one clears it", async () => {
    const blocks = entryBlocks({
      ...ENTRY_READY,
      withdrawalInFlight: true,
      linkHold: { kind: "expiry", until: 2000 },
      balance: DAI + 1n,
      fundingAmount: 2n * DAI + 1n,
    })
    const onAct = vi.fn()
    await show(<BlockedScreen screen={{ id: "blocked", blocks }} actions={actions(onAct)} />)
    expect(rows()).toHaveLength(4)
    expect(container.querySelectorAll(".zkm-checklist-row--muted")).toHaveLength(1)
    expect(text()).toContain(blockedCopy.registered.done.label)
    // The need rounds up and the balance down, so the two never read as equal while one is short.
    expect(text()).toContain(fmt(blockedCopy.balance.label, { need: "$2.01" }))
    expect(text()).toContain(fmt(blockedCopy.balance.detail, { have: "$1.00" }))
    expect(button(blockedCopy.withdrawal.action)).toBeDefined()
    // A paylink that can only expire has nothing to open.
    expect(button(blockedCopy.link.action)).toBeUndefined()
    expect(button(blockedCopy.add)?.disabled).toBe(true)
    await act(async () => button(blockedCopy.balance.action)!.click())
    expect(onAct).toHaveBeenCalledWith("deposit")
  })

  it("gives a short balance its own sheet: the need, the part back, Deposit, the add closed", async () => {
    const onAct = vi.fn()
    await show(<LowBalanceScreen screen={LOW} actions={actions(onAct)} />)
    // The total Pay shows at Standard, so the need and the hold add up with the fee.
    expect(text()).toContain(fmt(lowCopy.lead, { need: "$2.06", hold: "$1.50", have: "$0.80" }))
    expect(button(lowCopy.add)?.disabled).toBe(true)
    await act(async () => button(lowCopy.deposit)!.click())
    expect(onAct).toHaveBeenCalledWith("deposit")
  })

  it("hides the balance on its own sheet while balances are hidden", async () => {
    await seedDeviceKeys({ hideBalances: "true" })
    await show(<LowBalanceScreen screen={LOW} actions={actions()} />)
    expect(text()).toContain(
      fmt(lowCopy.lead, { need: "$2.06", hold: "$1.50", have: HIDDEN_BALANCE }),
    )
  })

  it("hides the balance's figures while balances are hidden", async () => {
    await seedDeviceKeys({ hideBalances: "true" })
    for (const blocks of [
      entryBlocks({ ...ENTRY_READY, balance: DAI }),
      entryBlocks({ ...ENTRY_READY, chunk: { kind: "short", chunk: 9n * DAI } }),
    ]) {
      await show(<BlockedScreen screen={{ id: "blocked", blocks }} actions={actions()} />)
      expect(text()).toContain(HIDDEN_BALANCE)
      expect(text()).not.toContain("$9")
      await hide()
    }
  })

  it("leaves out the conditions that have sheets of their own", async () => {
    const blocks = entryBlocks({ ...ENTRY_READY, verified: false, routeLive: false })
    await show(<BlockedScreen screen={{ id: "blocked", blocks }} actions={actions()} />)
    expect(rows()).toHaveLength(1)
    expect(text()).toContain(blockedCopy.registered.pending.label)
  })
})

describe("B3, a read that failed", () => {
  it.each([
    ["keys", unreadableCopy.lead.online, false],
    ["records", unreadableCopy.lead.device, false],
    ["deps", unreadableCopy.lead.online, false],
    ["entry", unreadableCopy.lead.online, true],
  ] as const)("names a %s read, and closes back only from the add", async (read, lead, close) => {
    await show(<UnreadableScreen screen={{ id: "unreadable", read }} actions={actions()} />)
    expect(text()).toContain(unreadableCopy.title[read])
    expect(text()).toContain(lead)
    expect(Boolean(button(unreadableCopy.close))).toBe(close)
  })
})

describe("B4, signed in with the backup", () => {
  const signUp: BackupKey = { pubkeyHex: "aa", role: "sign-up", signsHere: false, name: "Mac" }

  it("names the key to sign in with, and offers the sign-out", async () => {
    await show(
      <FirstPasskeyScreen
        screen={{ id: "firstPasskey", keys: [signUp] }}
        actions={actions(noop)}
      />,
    )
    expect(text()).toContain(fmt(firstCopy.needed.at, { where: "Mac" }))
    // A one-key account does not list the session's key.
    expect(text()).toContain(firstCopy.signedIn.plain)
    expect(button(firstCopy.signOut)).toBeDefined()
  })

  it("names the backup signing here once the account lists it", async () => {
    const backup: BackupKey = { pubkeyHex: "bb", role: "backup", signsHere: true, provider: "P" }
    await show(
      <FirstPasskeyScreen
        screen={{ id: "firstPasskey", keys: [signUp, backup] }}
        actions={actions(noop)}
      />,
    )
    expect(text()).toContain(fmt(firstCopy.signedIn.at, { where: "P" }))
  })
})
