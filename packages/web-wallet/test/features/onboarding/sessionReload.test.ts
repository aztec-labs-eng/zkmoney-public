import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { seedDeviceKeys, testPage } from "../../support/page"
const h = vi.hoisted(() => ({ stale: false, reload: vi.fn() }))
const fakeAuth = () => ({ recordsStale: () => h.stale })
import { reloadIfSessionSwitched } from "../../../src/session/sessionReload"
import { walletStorage } from "../../../src/platform/storage/walletStorage"
import { savedIdentity, setIdentity } from "../../support/identity"
import {
  closeSession,
  namespaceOf,
  openSession,
  switchSession,
  type Session,
} from "../../../src/session/session"
import { pageSessionDeps } from "../../../src/app/sessionDeps"

const address = `0x${"ab".repeat(32)}`
let open: Session
/** A session for `id` this page has not made current: one a sign-in started under. */
const startedUnder = (id: string) =>
  openSession(pageSessionDeps(testPage(fakeAuth()))(namespaceOf(id)))

describe("reloadIfSessionSwitched", () => {
  beforeEach(() => {
    localStorage.clear()
    h.stale = false
    h.reload.mockClear()
    vi.stubGlobal("window", { location: { reload: h.reload }, dispatchEvent: vi.fn() })
    vi.stubGlobal("location", { reload: h.reload })
    open = switchSession({ id: null, prefix: "" }, pageSessionDeps(testPage(fakeAuth())))
  })
  afterEach(() => {
    closeSession()
    vi.unstubAllGlobals()
  })

  it("reloads after a switch once the committed account's unrelated identity is gone", async () => {
    await seedDeviceKeys({ storageId: "new-account" })
    await setIdentity({ address: "other-account" })
    const session = startedUnder("old-account")
    expect(reloadIfSessionSwitched(session, address)).toBe(true)
    session.close()
    await vi.waitFor(() => expect(h.reload).toHaveBeenCalledTimes(1))
    expect(await savedIdentity()).toBeNull()
  })

  it("reloads when recovery into an existing namespace left stores stale without an old pointer", async () => {
    h.stale = true
    await seedDeviceKeys({ storageId: "existing-account" })
    await walletStorage.flush()
    expect(reloadIfSessionSwitched(open, address)).toBe(true)
    await vi.waitFor(() => expect(h.reload).toHaveBeenCalledTimes(1))
  })

  it("keeps a fresh or unchanged account on the current page", async () => {
    await seedDeviceKeys({ storageId: "same-account" })
    await walletStorage.flush()
    expect(reloadIfSessionSwitched(open, address)).toBe(false)
    const session = startedUnder("same-account")
    expect(reloadIfSessionSwitched(session, address)).toBe(false)
    session.close()
    await walletStorage.flush()
    expect(h.reload).not.toHaveBeenCalled()
  })

  // Last: from here on this page has served "acct-a".
  it("reloads a passkey reuse that committed another account than the page serves", async () => {
    open = switchSession({ id: "acct-a", prefix: "a." }, pageSessionDeps(testPage(fakeAuth())))
    await seedDeviceKeys({ storageId: "acct-b" })
    await walletStorage.flush()
    expect(reloadIfSessionSwitched(open, address)).toBe(true)
    await vi.waitFor(() => expect(h.reload).toHaveBeenCalledTimes(1))
    closeSession()
  })

  it("reloads a sign-in after a dropped key when the page served another account", async () => {
    switchSession({ id: "acct-a", prefix: "a." }, pageSessionDeps(testPage(fakeAuth())))
    // The dropped key: the page falls back to the anonymous namespace.
    closeSession()
    open = switchSession({ id: null, prefix: "" }, pageSessionDeps(testPage(fakeAuth())))
    await seedDeviceKeys({ storageId: "acct-b" })
    await walletStorage.flush()
    expect(reloadIfSessionSwitched(open, address)).toBe(true)
    await vi.waitFor(() => expect(h.reload).toHaveBeenCalledTimes(1))
    closeSession()
  })
})
