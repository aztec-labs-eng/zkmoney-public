import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setIdentity } from "../../../support/identity"
import { resetDemoFlagForTests } from "../../../../src/dev/demoFlag"

const useSponsoredRailPending = vi.fn()
vi.mock("../../../../src/features/registration/sponsoredRailReadiness", () => ({
  useSponsoredRailPending,
}))
vi.mock("../../../../src/features/contacts/ContactDetailScreen/ContactDetailScreen", () => ({
  ContactDetailScreen: () => <div>contact page</div>,
}))
vi.mock("../../../../src/features/contacts/SendScreen/SendScreen", () => ({
  SendScreen: () => <div>send list</div>,
}))
vi.mock("../../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/config/env")>()),
  getConfig: () => ({ oxideProfile: { portal: "0x" + "11".repeat(20) } }),
}))
const { ActionGate, ContactRoute } = await import("../../../../src/App")
const { migrationDialogReason, setUpgradeStatus, useMigrationDialogRequest } = await import(
  "../../../../src/features/migration/migrationDialog"
)
const { checkUpgradeLock, markCreatedHere } = await import(
  "../../../../src/features/migration/upgradeLock"
)
/**
 * One gate fronts the wallet's action routes. A nameless account is sent to register one. The flows
 * whose only rail is ClaimFPC-sponsored wait for it: the open rail admits an account the L1 registry
 * registered, and the registry's proof is a name plus the L1->L2 message it emits, which a
 * just-registered account gets a few L1 blocks later. Each stops the attempt with the reason rather
 * than at the fee. Deposit needs only the name: its address derives from the account, and the
 * broadcast behind it waits for the rail in the background. Every action waits for the upgrade.
 */
const { activeNamespace, closeSession, switchSession } = await import(
  "../../../../src/session/session"
)
const { pageSessionDeps } = await import("../../../../src/app/sessionDeps")
const { openTestSession } = await import("../../../support/session")
const { testPage, testCore } = await import("../../../support/page")
beforeEach(
  () =>
    switchSession(activeNamespace(testCore().device), pageSessionDeps(testPage())).registrations
      .ready,
)
afterEach(closeSession)

describe("gates on the wallet's flows", () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    // The wallet's mount reads each account's upgrade runs once a page; until then flows wait.
    await checkUpgradeLock("0xabc")
    await checkUpgradeLock("0xdef")
    await openTestSession().registrations.ready
    window.history.replaceState({}, "", "/")
    sessionStorage.removeItem("webwallet.demo")
    resetDemoFlagForTests()
    await setIdentity(null)
    useSponsoredRailPending.mockReset()
    useSponsoredRailPending.mockReturnValue(false)
    setUpgradeStatus({ state: "none", registration: false })
    host = document.createElement("div")
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
    window.history.replaceState({}, "", "/")
    sessionStorage.removeItem("webwallet.demo")
    resetDemoFlagForTests()
  })

  const mount = (path = "send", action: Parameters<typeof ActionGate>[0]["action"] = "send") =>
    act(() => {
      root.render(
        <MemoryRouter initialEntries={[`/${path}`]}>
          <Routes>
            <Route path="/" element={<div>home screen</div>} />
            <Route element={<ActionGate action={action} />}>
              <Route path={path} element={<div data-testid={path}>{path} screen</div>} />
            </Route>
          </Routes>
        </MemoryRouter>,
      )
    })

  describe("name gate", () => {
    it("blocks the attempt, and says why, when the account has no name", async () => {
      await setIdentity({ address: "0xabc" })
      mount("deposit", "deposit")
      expect(host.querySelector('[data-testid="name-required"]')).toBeTruthy()
      expect(host.textContent).toContain("Register a name first")
      expect(host.textContent).not.toContain("deposit screen")
    })

    it("does not block before an identity exists — WalletGate owns that case", async () => {
      await setIdentity(null)
      mount("deposit", "deposit")
      expect(host.textContent).toContain("deposit screen")
    })

    it("opens the deposit screen while the registration message is still in flight", async () => {
      // The address needs no rail; its broadcast waits in the background.
      await setIdentity({ address: "0xabc", handle: "taga" })
      useSponsoredRailPending.mockReturnValue(true)
      mount("deposit", "deposit")
      expect(host.textContent).toContain("deposit screen")
      expect(host.querySelector('[data-testid="registration-pending"]')).toBeNull()
    })
  })

  it.each([undefined, true])("holds a sponsored flow while the rail reads %s", async (pending) => {
    await setIdentity({ address: "0xabc", handle: "taga" })
    useSponsoredRailPending.mockReturnValue(pending)
    mount("withdraw", "withdraw")
    expect(host.querySelector('[data-testid="withdraw"]')).toBeNull()
    expect(!!host.querySelector('[data-testid="registration-pending"]')).toBe(pending === true)
  })

  describe("the upgrade", () => {
    let requests = 0
    function Requests() {
      requests = useMigrationDialogRequest()
      return null
    }
    const mountWithRequests = (
      path: string,
      action: Parameters<typeof ActionGate>[0]["action"],
      attempt = 0,
    ) =>
      act(() => {
        root.render(
          <MemoryRouter key={attempt} initialEntries={[`/${path}`]}>
            <Routes>
              <Route path="/" element={<div>home screen</div>} />
              <Route element={<ActionGate action={action} />}>
                <Route path={path} element={<div>{path} screen</div>} />
              </Route>
            </Routes>
            <Requests />
          </MemoryRouter>,
        )
      })
    afterEach(() => act(() => setUpgradeStatus({ state: "none", registration: false })))

    it.each([["send", "send"]] as const)(
      "leaves /%s for Home and asks to upgrade first, titled for the action",
      async (path, action) => {
        await setIdentity({ address: "0xabc", handle: "taga" })
        setUpgradeStatus({ state: "offered", registration: false })
        const before = requests
        mountWithRequests(path, action)
        expect(host.textContent).toContain("home screen")
        expect(host.textContent).not.toContain(`${path} screen`)
        expect(requests).toBe(before + 1)
        expect(migrationDialogReason()).toEqual({ action })
      },
    )

    it("asks to upgrade ahead of the registration the upgrade sends", async () => {
      await setIdentity({ address: "0xabc", handle: "taga" })
      useSponsoredRailPending.mockReturnValue(true)
      setUpgradeStatus({ state: "offered", registration: true })
      mountWithRequests("send", "send")
      expect(host.textContent).toContain("home screen")
      expect(host.textContent).not.toContain("Finishing your registration")
    })

    it("holds the attempt while whether to upgrade is not known, then opens it", async () => {
      await setIdentity({ address: "0xabc", handle: "taga" })
      setUpgradeStatus({ state: "checking", registration: false })
      mountWithRequests("send", "send")
      expect(host.textContent).toContain("Loading zk.money")
      expect(host.textContent).not.toContain("send screen")
      act(() => setUpgradeStatus({ state: "none", registration: false }))
      expect(host.textContent).toContain("send screen")
    })

    it("never holds an account current on this version", async () => {
      await setIdentity({ address: "0xdef", handle: "tagb" })
      markCreatedHere("0xdef")
      setUpgradeStatus({ state: "checking", registration: false })
      mountWithRequests("send", "send")
      expect(host.textContent).toContain("send screen")
    })

    it("opens the action once the upgrade is done", async () => {
      await setIdentity({ address: "0xabc", handle: "taga" })
      setUpgradeStatus({ state: "running", phase: "arriving", registration: false })
      mountWithRequests("send", "send")
      expect(host.textContent).toContain("home screen")
      act(() => setUpgradeStatus({ state: "none", registration: false }))
      mountWithRequests("send", "send", 1)
      expect(host.textContent).toContain("send screen")
    })

    it.each(["/contacts/bob/send/"])(
      "leaves a contact's Send at %s for the contact's page, as a payment link opens it",
      async (path) => {
        await setIdentity({ address: "0xabc", handle: "taga" })
        setUpgradeStatus({ state: "offered", registration: false })
        const before = requests
        act(() => {
          root.render(
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route path="contacts/:idOrTag" element={<ContactRoute />}>
                  <Route path="send" element={<div>pay sheet</div>} />
                </Route>
              </Routes>
              <Requests />
            </MemoryRouter>,
          )
        })
        expect(host.textContent).not.toContain("pay sheet")
        expect(host.textContent).toContain("contact page")
        expect(requests).toBe(before + 1)
        expect(migrationDialogReason()).toEqual({ action: "send" })
      },
    )
  })
})
