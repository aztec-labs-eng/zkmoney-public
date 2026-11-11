import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { beforeAll, describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { setIdentity } from "../support/identity"

vi.mock("../../src/features/registration/openRegistration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/features/registration/openRegistration")>()),
  useNameClaimPending: () => false,
  useRegistrationDepositOwed: () => false,
}))
vi.mock("../../src/features/registration/sponsoredRailReadiness", () => ({
  useSponsoredRailPending: () => false,
}))

const { actionVerdict, useActionGuard } = await import("../../src/features/actionGate")
const { migrationDialogReason, setUpgradeStatus } = await import(
  "../../src/features/migration/migrationDialog"
)
type State = Parameters<typeof actionVerdict>[1]
type Action = Parameters<typeof actionVerdict>[0]

const ready: State = {
  named: true,
  claimPending: false,
  depositOwed: false,
  railPending: false,
  upgrade: "none",
  rerootPending: false,
  current: false,
  locked: false,
  lockChecked: true,
  demo: false,
  oldWithdrawable: false,
  moving: false,
}
const ACTIONS: Action[] = [
  "send",
  "receive",
  "deposit",
  "withdraw",
  "link",
  "requests",
  "savings",
  "claim",
]

const { openTestSession } = await import("../support/session")
const { defaultConfig } = await import("../support/page")
const { closeSession } = await import("../../src/session/session")
beforeEach(async () => {
  openTestSession()
  await setIdentity({ address: "0xabc", handle: "taga" })
})
afterEach(closeSession)

describe("whether an action may start", () => {
  it.each(ACTIONS)("starts %s once nothing waits", (action) => {
    expect(actionVerdict(action, ready)).toBe("open")
  })

  it.each(ACTIONS)("asks to upgrade first while %s waits on a known upgrade", (action) => {
    for (const upgrade of ["offered", "running", "stopped"] as const)
      expect(actionVerdict(action, { ...ready, upgrade, current: true })).toBe("upgrade")
    for (const upgrade of ["finishing", "failed"] as const)
      expect(actionVerdict(action, { ...ready, upgrade })).toBe("upgrade")
  })

  it.each(ACTIONS)("holds %s while whether to upgrade is not known", (action) => {
    expect(actionVerdict(action, { ...ready, upgrade: "checking" })).toBe("holding")
  })

  it.each(ACTIONS)("never holds %s for an account current on this version", (action) => {
    for (const upgrade of ["checking", "failed", "finishing"] as const)
      expect(actionVerdict(action, { ...ready, upgrade, current: true })).toBe("open")
  })

  it.each(ACTIONS)(
    "asks to upgrade first while the lock is held, even if %s's account is current",
    (action) => {
      for (const upgrade of ["none", "checking", "failed"] as const)
        expect(actionVerdict(action, { ...ready, upgrade, current: true, locked: true })).toBe(
          "upgrade",
        )
    },
  )

  it.each(ACTIONS)("holds %s until the page has read the account's upgrade runs", (action) => {
    expect(actionVerdict(action, { ...ready, current: true, lockChecked: false })).toBe("holding")
  })

  it("never holds the demo", () => {
    for (const action of ACTIONS)
      expect(actionVerdict(action, { ...ready, upgrade: "offered", demo: true })).toBe("open")
  })

  it("asks a nameless account for a name before anything else", () => {
    const nameless = { ...ready, named: false, upgrade: "offered" as const }
    for (const action of ["send", "withdraw", "link", "deposit"] as const)
      expect(actionVerdict(action, nameless)).toBe("name")
    expect(actionVerdict("receive", nameless)).toBe("upgrade")
  })

  it("refunds an old version's funds on withdraw, ahead of the name, claim, upgrade and rail", () => {
    const blocked = {
      ...ready,
      oldWithdrawable: true,
      named: false,
      claimPending: true,
      upgrade: "offered" as const,
      railPending: true,
    }
    expect(actionVerdict("withdraw", blocked)).toBe("refund")
    expect(actionVerdict("send", { ...ready, oldWithdrawable: true, upgrade: "offered" })).toBe(
      "upgrade",
    )
  })

  it("sends a pending tag claim home, except a deposit the registration owes", () => {
    const claiming = { ...ready, claimPending: true }
    for (const action of ["send", "withdraw", "link", "deposit", "receive", "requests"] as const)
      expect(actionVerdict(action, claiming)).toBe("home")
    expect(actionVerdict("deposit", { ...claiming, depositOwed: true })).toBe("open")
    expect(actionVerdict("savings", claiming)).toBe("open")
  })

  it("keeps a deposit the registration owes open, whatever the upgrade's state", () => {
    for (const upgrade of ["checking", "failed", "offered"] as const) {
      expect(actionVerdict("deposit", { ...ready, depositOwed: true, upgrade })).toBe("open")
      expect(actionVerdict("send", { ...ready, depositOwed: true, upgrade })).not.toBe("open")
    }
  })

  it("waits on the sponsored rail only for the actions it carries", () => {
    for (const action of ["send", "withdraw", "link"] as const) {
      expect(actionVerdict(action, { ...ready, railPending: undefined })).toBe("checking")
      expect(actionVerdict(action, { ...ready, railPending: true })).toBe("registering")
    }
    for (const action of ["deposit", "receive", "requests", "savings", "claim"] as const)
      expect(actionVerdict(action, { ...ready, railPending: true })).toBe("open")
  })

  it("holds a new link and a Savings move, and nothing else, while a backup passkey add has yet to switch the account", () => {
    const adding = { ...ready, rerootPending: true }
    for (const action of ["link", "savings"] as const) {
      expect(actionVerdict(action, adding)).toBe("backup")
      expect(actionVerdict(action, { ...adding, upgrade: "offered" })).toBe("upgrade")
      expect(actionVerdict(action, { ...adding, demo: true })).toBe("open")
    }
    for (const action of ACTIONS.filter((a) => a !== "link" && a !== "savings"))
      expect(actionVerdict(action, adding)).toBe("open")
  })

  it("checks a new link and a Savings move while the rotations are not read, never opening them", () => {
    const unread = { ...ready, rerootPending: undefined }
    for (const action of ["link", "savings"] as const) {
      expect(actionVerdict(action, unread)).toBe("checking")
      expect(actionVerdict(action, { ...unread, demo: true })).toBe("open")
    }
    for (const action of ACTIONS.filter((a) => a !== "link" && a !== "savings"))
      expect(actionVerdict(action, unread)).toBe("open")
  })

  it("pauses only the actions that spend through the sponsor while a balance moves", () => {
    const moving = { ...ready, moving: true }
    for (const action of ["send", "withdraw", "link", "savings", "claim"] as const) {
      expect(actionVerdict(action, moving)).toBe("moving")
      expect(actionVerdict(action, { ...moving, demo: true })).toBe("open")
    }
    for (const action of ["deposit", "receive", "requests"] as const)
      expect(actionVerdict(action, moving)).toBe("open")
  })

  it("names what the account lacks ahead of a balance move", () => {
    const moving = { ...ready, moving: true }
    expect(actionVerdict("send", { ...moving, named: false })).toBe("name")
    expect(actionVerdict("send", { ...moving, claimPending: true })).toBe("home")
    expect(actionVerdict("send", { ...moving, upgrade: "offered" })).toBe("upgrade")
    expect(actionVerdict("withdraw", { ...moving, oldWithdrawable: true })).toBe("refund")
    expect(actionVerdict("send", { ...moving, railPending: true })).toBe("moving")
  })

  it("asks for the upgrade ahead of the rail an upgrade registers", () => {
    expect(actionVerdict("send", { ...ready, railPending: true, upgrade: "offered" })).toBe(
      "upgrade",
    )
  })
})

describe("starting an action from a press", () => {
  // The wallet's mount reads the account's upgrade runs once a page; until then every press waits.
  beforeAll(async () => {
    const { checkUpgradeLock } = await import("../../src/features/migration/upgradeLock")
    await checkUpgradeLock(defaultConfig, "0xabc")
  })
  function press(action: Action) {
    let guard!: ReturnType<typeof useActionGuard>
    function Probe() {
      guard = useActionGuard()
      return null
    }
    const root = createRoot(document.createElement("div"))
    act(() => root.render(createElement(Probe)))
    const run = vi.fn()
    act(() => guard(action, run))
    return Object.assign(run, { leave: () => act(() => root.unmount()) })
  }

  it("holds it in the upgrade sheet while that is not known, ready to start it", () => {
    setUpgradeStatus({ state: "checking", registration: false })
    const run = press("savings")
    expect(run).not.toHaveBeenCalled()
    const reason = migrationDialogReason() as { action: Action; then?: () => void }
    expect(reason.action).toBe("savings")
    reason.then!()
    expect(run).toHaveBeenCalledOnce()
    run.leave()
  })

  it("drops a held action once the screen that started it is gone", () => {
    setUpgradeStatus({ state: "checking", registration: false })
    const run = press("claim")
    const reason = migrationDialogReason() as { action: Action; then?: () => void }
    run.leave()
    reason.then!()
    expect(run).not.toHaveBeenCalled()
  })
})
