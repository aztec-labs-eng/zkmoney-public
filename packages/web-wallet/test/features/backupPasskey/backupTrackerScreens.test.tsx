/** Which button each tracker screen offers for its props, what it runs, and what it announces. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { failureLine, type BackupFailure } from "../../../src/features/backupPasskey/backupFailure"
import type {
  BackupActions,
  BackupScreen,
  Tracked,
} from "../../../src/features/backupPasskey/backupScreen"
import trackerCopy from "../../../src/features/backupPasskey/screens/AddTracker/AddTracker.copy"
import { AddingScreen } from "../../../src/features/backupPasskey/screens/AddingScreen/AddingScreen"
import { ApproveScreen } from "../../../src/features/backupPasskey/screens/ApproveScreen/ApproveScreen"
import { DoneScreen } from "../../../src/features/backupPasskey/screens/DoneScreen/DoneScreen"
import { FinishScreen } from "../../../src/features/backupPasskey/screens/FinishScreen/FinishScreen"
import { closeSession } from "../../../src/session/session"
import { PLAN } from "../../support/backupAdd"
import { openTestSession } from "../../support/session"

const DAI = 10n ** 18n
const at = (step: 2 | 3 | 4, stage: Tracked["progress"]["stage"]): Tracked => ({
  progress: { step, stage },
  busy: false,
  checking: false,
  canCancel: step === 2,
})
const unknown: BackupFailure = {
  kind: "unknown",
  step: "resume",
  charged: "funding",
  leftover: false,
  error: new Error("rpc"),
}
const closed: BackupFailure = {
  kind: "declined",
  step: "move",
  charged: "funding",
  leftover: false,
}
const PAY = {
  plan: PLAN,
  sent: 2n * DAI,
  fees: (6n * DAI) / 10n,
  credited: (14n * DAI) / 10n,
  takesMs: 40 * 60_000,
  address: "0x2b",
  approvals: 1,
  refunds: 0,
  moves: 1,
}
const finish = { approving: false, declined: false, paused: false, linkExpiring: false }
const failedRead: BackupScreen = { id: "approve", ...at(2, "publish"), failure: unknown }
const c7: BackupScreen = {
  id: "finish",
  ...at(4, "moving"),
  ...finish,
  ask: "retry",
  declined: true,
  failure: closed,
}
const pausedMove: BackupScreen = {
  id: "finish",
  ...at(4, "moving"),
  ...finish,
  ask: "retry",
  paused: true,
}

let root: Root | undefined
let container: HTMLDivElement

function unmount() {
  if (!root) return
  act(() => root!.unmount())
  container.remove()
  root = undefined
  closeSession()
}

function render(screen: BackupScreen) {
  unmount()
  // The pay step quotes its speed on the session's wallet; a test session has none built.
  openTestSession()
  const actions = new Proxy({} as Record<string, () => void>, {
    get: (fns, name: string) => (fns[name] ??= vi.fn()),
  }) as unknown as BackupActions
  container = document.createElement("div")
  document.body.appendChild(container)
  const at = createRoot(container)
  root = at
  act(() => {
    switch (screen.id) {
      case "approve":
        return at.render(<ApproveScreen screen={screen} actions={actions} />)
      case "adding":
        return at.render(<AddingScreen screen={screen} actions={actions} />)
      case "finish":
        return at.render(<FinishScreen screen={screen} actions={actions} />)
      case "done":
        return at.render(<DoneScreen screen={screen} actions={actions} />)
      default:
        throw new Error(`no tracker screen ${screen.id}`)
    }
  })
  return actions
}

const tap = (testId: string) =>
  act(() => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.click())
const alert = () => container.querySelector('[role="alert"]')?.textContent ?? null

afterEach(unmount)

describe("the tracker screens", () => {
  it.each<[string, BackupScreen, string, keyof BackupActions]>([
    ["A4 approves", { id: "approve", ...at(2, "sign") }, "backup-approve", "approve"],
    ["A4 cancels before paying", { id: "approve", ...at(2, "sign") }, "backup-cancel", "cancel"],
    [
      "the pay step pays",
      { id: "approve", ...at(2, "pay"), pay: PAY },
      "backup-fund-continue",
      "fund",
    ],
    ["a failed read before paying checks again", failedRead, "backup-watch-retry", "check"],
    [
      "A5 closes",
      { id: "adding", ...at(3, "funded"), timing: { takesMs: 1, leftMs: 1 } },
      "backup-close",
      "close",
    ],
    [
      "C6 checks again",
      { id: "adding", ...at(3, "funded"), delay: "late" },
      "backup-check-again",
      "check",
    ],
    [
      "A6 approves the last step",
      { id: "finish", ...at(4, "moving"), ...finish, ask: "approve" },
      "backup-move-approve",
      "approveMove",
    ],
    ["C7 asks again", c7, "backup-move-retry", "retryMove"],
    ["a paused move tries again", pausedMove, "backup-move-retry", "retryMove"],
    [
      "step 4 held on the sponsor's uses checks again",
      { id: "finish", ...at(4, "moving"), ...finish, delay: "uses" },
      "backup-check-again",
      "check",
    ],
    ["A7 finishes", { id: "done", keys: [], unlisted: {} }, "backup-done", "finish"],
  ])("%s", (_, screen, testId, action) => {
    const actions = render(screen)
    tap(testId)
    expect(actions[action]).toHaveBeenCalledTimes(1)
  })

  it.each<[string, boolean, BackupScreen]>([
    ["A5 waits", true, { id: "adding", ...at(3, "funded"), timing: { takesMs: 1, leftMs: 1 } }],
    ["C6 waits", true, { id: "adding", ...at(3, "funded"), delay: "late" }],
    ["a failed read", false, failedRead],
    ["a failed read checked again", true, { ...failedRead, checking: true }],
    ["a paused move", false, pausedMove],
    ["C7 asking again", true, { ...c7, busy: true }],
  ])("%s: the current step's ring turns = %s", (_, spins, screen) => {
    render(screen)
    const current = '[aria-current="step"]'
    expect(container.querySelector(`${current} [role="progressbar"]`)).not.toBeNull()
    expect(container.querySelector(`${current} .zkm-spinner-icon`) !== null).toBe(spins)
  })

  it("announces a failure on the step, and a delay once rather than its minute count", () => {
    render({ id: "adding", ...at(3, "funded"), delay: "route", checkedAgoMs: 120_000 })
    expect(alert()).toBe(trackerCopy.delayed)
    render({ id: "adding", ...at(3, "funded"), delay: "route", failure: unknown })
    expect(alert()).toBe(failureLine(unknown))
  })

  it("lists the sign-up key and the backup the key read predates", () => {
    const signUp = { pubkeyHex: "aa", role: "sign-up" as const, signsHere: true }
    render({ id: "done", keys: [signUp], unlisted: { savedIn: { securityKey: true } } })
    expect(container.querySelectorAll(".zkm-key-status-row")).toHaveLength(2)
    render({ id: "done", keys: [signUp, { ...signUp, pubkeyHex: "bb", role: "backup" }] })
    expect(container.querySelectorAll(".zkm-key-status-row")).toHaveLength(2)
  })
})
