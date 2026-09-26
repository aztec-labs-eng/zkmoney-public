import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const h = vi.hoisted(() => ({ stale: false, reload: vi.fn() }))
vi.mock("../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ recordsStale: () => h.stale }),
}))
import { reloadIfSessionSwitched } from "../src/features/onboarding/sessionReload"
import { setActiveStorageId } from "../src/platform/storage/activeStorage"
import { loadWalletIdentity, saveWalletIdentity } from "../src/features/identity/walletIdentity"

const address = `0x${"ab".repeat(32)}`

describe("reloadIfSessionSwitched", () => {
  beforeEach(() => {
    localStorage.clear()
    h.stale = false
    h.reload.mockClear()
    vi.stubGlobal("window", { location: { reload: h.reload }, dispatchEvent: vi.fn() })
  })
  afterEach(() => vi.unstubAllGlobals())

  it("reloads after an account switch and clears the unrelated entered identity", () => {
    saveWalletIdentity({ address: "other-account", claimedAt: 1 })
    setActiveStorageId("new-account")
    expect(reloadIfSessionSwitched("old-account", address)).toBe(true)
    expect(h.reload).toHaveBeenCalledTimes(1)
    expect(loadWalletIdentity()).toBeNull()
  })

  it("reloads when recovery into an existing namespace left stores stale without an old pointer", () => {
    h.stale = true
    setActiveStorageId("existing-account")
    expect(reloadIfSessionSwitched(null, address)).toBe(true)
    expect(h.reload).toHaveBeenCalledTimes(1)
  })

  it("keeps a fresh or unchanged account on the current page", () => {
    setActiveStorageId("same-account")
    expect(reloadIfSessionSwitched(null, address)).toBe(false)
    expect(reloadIfSessionSwitched("same-account", address)).toBe(false)
    expect(h.reload).not.toHaveBeenCalled()
  })
})
