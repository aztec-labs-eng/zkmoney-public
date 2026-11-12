/** Which button each tracker screen offers for its props, what it runs, and what it announces. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { failureLine, type BackupFailure } from "../../../src/features/backupPasskey/backupFailure"
import { relandingCopy } from "../../../src/features/backupPasskey/backupPasskeyCopy"
import type {
  BackupActions,
  BackupScreen,
  Tracked,
} from "../../../src/features/backupPasskey/backupScreen"
import { approveLabel } from "../../../src/features/backupPasskey/screens/AddTracker/AddTracker"
import trackerCopy from "../../../src/features/backupPasskey/screens/AddTracker/AddTracker.copy"
import { AddingScreen } from "../../../src/features/backupPasskey/screens/AddingScreen/AddingScreen"
import { ApproveScreen } from "../../../src/features/backupPasskey/screens/ApproveScreen/ApproveScreen"
import { DoneScreen } from "../../../src/features/backupPasskey/screens/DoneScreen/DoneScreen"
import { FinishScreen } from "../../../src/features/backupPasskey/screens/FinishScreen/FinishScreen"
import finishCopy from "../../../src/features/backupPasskey/screens/FinishScreen/FinishScreen.copy"
import { fmt } from "../../../src/lib/fmt"
import { closeSession } from "../../../src/session/session"
import stepsCopy from "../../../src/ui/MoveSteps/MoveSteps.copy"
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
/** Step 4 while the move runs, with `progress` over it. */
const moving = (progress: Partial<Tracked["progress"]>): Tracked => {
  const tracked = at(4, "moving")
  return { ...tracked, progress: { ...tracked.progress, ...progress } }
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
const texts = (selector: string) =>
  [...container.querySelectorAll(selector)].map((node) => node.textContent)
const labels = () => texts(".zkm-step-tracker__step-label")
const details = () => texts(".zkm-step-tracker__detail")

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
      { id: "adding", ...at(3, "funded"), timing: { leftMs: 1 } },
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
    ["A5 waits", true, { id: "adding", ...at(3, "funded"), timing: { leftMs: 1 } }],
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

  it("shows step 4 as the move's rows once they are read, the asking row naming the approver", () => {
    const rows = [
      { kind: "links", count: 1, state: "done" },
      { kind: "main", state: "confirming" },
      { kind: "savings", state: "next" },
    ] as const
    const moved = { included: 1, total: 2 }
    render({ id: "finish", ...moving({ rows, moved }), ...finish, ask: "approve" })
    expect(container.textContent).toContain(finishCopy.step)
    expect(container.textContent).toContain(finishCopy.one)
    expect(labels()).toEqual([finishCopy.rows.link, finishCopy.rows.main, finishCopy.rows.savings])
    expect(details()).toEqual([stepsCopy.confirming, approveLabel({})])
    expect(container.querySelector('[data-testid="backup-move-approve"]')).not.toBeNull()
    // The tap's send is out: the row prepares it.
    render({ id: "finish", ...moving({ rows, moved }), ...finish, ask: "approve", approving: true })
    expect(details()).toEqual([stepsCopy.confirming, stepsCopy.preparing])
    // Before the rows are read, and on the delayed sheet, the add's four steps stand.
    render({ id: "finish", ...moving({ moved }), ...finish, ask: "approve" })
    expect(labels()).toContain(trackerCopy.saved)
    render({ id: "finish", ...moving({ rows, moved }), ...finish, delay: "uses" })
    expect(labels()).toContain(trackerCopy.saved)
  })

  it("offers Close on the working step only once no approval is left", () => {
    const close = () => container.querySelector('[data-testid="backup-close"]')
    const toCome = [
      { kind: "main", state: "confirming" },
      { kind: "savings", state: "todo" },
    ] as const
    render({ id: "finish", ...moving({ rows: toCome, moved: { included: 1, total: 2 } }), ...finish })
    expect(close()).toBeNull()
    expect(container.textContent).toContain(finishCopy.working.keepOpen.one)
    render({ id: "finish", ...moving({ rows: toCome, moved: { included: 0, total: 3 } }), ...finish })
    expect(close()).toBeNull()
    expect(container.textContent).toContain(fmt(finishCopy.working.keepOpen.count, { count: 3 }))
    const links = [
      { kind: "links", count: 2, state: "next" },
      { kind: "funds", state: "todo" },
    ] as const
    // A transfer approved and sent no longer counts, though no block holds it yet.
    render({
      id: "finish",
      ...moving({ rows: toCome, moved: { included: 0, total: 2 }, out: 1 }),
      ...finish,
    })
    expect(close()).toBeNull()
    expect(container.textContent).toContain(finishCopy.working.keepOpen.one)
    const waiting = moving({ rows: links, refunds: { landed: 0, total: 2 } })
    render({ id: "finish", ...waiting, ...finish })
    expect(close()).toBeNull()
    expect(container.textContent).toContain(finishCopy.working.keepOpen.several)
    expect(labels()[0]).toBe(fmt(finishCopy.rows.links, { count: 2 }))
    // A paylink's expiry can be a long wait, so the sheet says it may be closed.
    render({ id: "finish", ...waiting, ...finish, linkExpiring: true })
    expect(close()).not.toBeNull()
    expect(container.textContent).toContain(finishCopy.working.lead)
    expect(details()).toEqual([finishCopy.working.linkExpiring])
    const confirming = [
      { kind: "main", state: "done" },
      { kind: "savings", state: "confirming" },
    ] as const
    const actions = render({
      id: "finish",
      ...moving({ rows: confirming, moved: { included: 2, total: 2 } }),
      ...finish,
    })
    expect(container.textContent).toContain(finishCopy.working.lead)
    expect(container.textContent).not.toContain(finishCopy.one)
    tap("backup-close")
    expect(actions.close).toHaveBeenCalledTimes(1)
  })

  it("warns under the rows while a closed prompt or a pause holds the move, no row working", () => {
    const rows = [
      { kind: "main", state: "confirming" },
      { kind: "savings", state: "next" },
    ] as const
    const held = { id: "finish", ...moving({ rows }), ...finish, ask: "retry" } as const
    render({ ...held, declined: true, failure: closed })
    expect(alert()).toBe(trackerCopy.closed)
    expect(container.querySelector('[aria-current="step"]')).toBeNull()
    expect(details()).toEqual([stepsCopy.confirming])
    render({ ...held, paused: true })
    expect(alert()).toBe(finishCopy.paused.detail)
    expect(container.querySelector('[aria-current="step"]')).toBeNull()
    // A failure wins over the pause's own line.
    render({ ...held, paused: true, failure: unknown })
    expect(alert()).toBe(failureLine(unknown))
  })

  it("says under the move's rows that the network confirms the backup again", () => {
    const rows = [{ kind: "main", state: "next" }] as const
    render({ id: "finish", ...moving({ rows }), ...finish, ask: "approve" })
    expect(container.textContent).not.toContain(relandingCopy.title)
    render({ id: "finish", ...moving({ rows, relanding: true }), ...finish, ask: "approve" })
    expect(container.textContent).toContain(relandingCopy.title)
    expect(container.textContent).toContain(relandingCopy.line)
  })

  it("lists the sign-up key and the backup the key read predates", () => {
    const signUp = { pubkeyHex: "aa", role: "sign-up" as const, signsHere: true }
    render({ id: "done", keys: [signUp], unlisted: { savedIn: { securityKey: true } } })
    expect(container.querySelectorAll(".zkm-key-status-row")).toHaveLength(2)
    render({ id: "done", keys: [signUp, { ...signUp, pubkeyHex: "bb", role: "backup" }] })
    expect(container.querySelectorAll(".zkm-key-status-row")).toHaveLength(2)
  })
})
