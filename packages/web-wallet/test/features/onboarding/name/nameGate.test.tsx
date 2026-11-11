/** Guards: no action starts while the upgrade runs or is not known, then it opens. */
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
const { ActionGate, ContactRoute } = await import("../../../../src/App")
const { migrationDialogReason, setUpgradeStatus, useMigrationDialogRequest } = await import(
  "../../../../src/features/migration/migrationDialog"
)
const { checkUpgradeLock, markCreatedHere } = await import(
  "../../../../src/features/migration/upgradeLock"
)
const { activeNamespace, closeSession, switchSession } = await import(
  "../../../../src/session/session"
)
const { pageSessionDeps } = await import("../../../../src/app/sessionDeps")
const { openTestSession } = await import("../../../support/session")
const { testPage, testCore, defaultConfig } = await import("../../../support/page")
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
    await checkUpgradeLock(defaultConfig, "0xabc")
    await checkUpgradeLock(defaultConfig, "0xdef")
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
    window.history.replaceState({}, "", "/")
    sessionStorage.removeItem("webwallet.demo")
    resetDemoFlagForTests()
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
      markCreatedHere(defaultConfig, "0xdef")
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
