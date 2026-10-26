import { beforeEach, describe, expect, it, vi } from "vitest"
import { walletStorage } from "../src/platform/storage/walletStorage"
import { testWalletDbs } from "./support/fakeWalletDb"

const h = vi.hoisted(() => ({ showReportableError: vi.fn() }))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: h.showReportableError }))
vi.mock("../src/platform/auth/useAuthenticator", () => ({ peekAuthService: () => undefined }))
vi.mock("../src/config/env", () => ({ getConfig: () => ({ rpId: "localhost" }) }))
vi.mock("../src/platform/auth/WebPasskeyIdentityMap", () => ({
  hasOpeningBreadcrumb: () => false,
  rememberUsertag: () => Promise.resolve(),
}))
vi.mock("../src/features/identity/admission", () => ({ clearAdmission: () => {} }))

import { logout } from "../src/features/identity/logout"
import { saveWalletIdentity, loadWalletIdentity } from "../src/features/identity/walletIdentity"
import {
  getActiveCredentialId,
  getActiveStorageId,
  readCachedMsk,
  setActiveCredentialId,
  setActiveStorageId,
  writeCachedMsk,
} from "../src/platform/storage/activeStorage"

describe("logout", () => {
  const assign = vi.fn()
  const stopPxe = vi.fn(async () => {})
  beforeEach(() => {
    localStorage.clear()
    assign.mockClear()
    stopPxe.mockClear()
    h.showReportableError.mockClear()
    Object.defineProperty(window, "location", { value: { assign }, writable: true })
  })

  it("clears the active session, stops the PXE, then hard-reloads", async () => {
    saveWalletIdentity({ handle: "@alice", address: "0xa", claimedAt: 1 })
    setActiveStorageId("aaa")
    setActiveCredentialId("cred-a")
    writeCachedMsk({ v: 1, storageId: "aaa", credentialId: "cred-a", msk: `0x${"11".repeat(32)}` })
    walletStorage.setItem("obsidion.aaa.obsidion_contacts", "keep")
    await logout(stopPxe)
    expect(loadWalletIdentity()).toBeNull()
    expect(getActiveStorageId()).toBeNull()
    expect(getActiveCredentialId()).toBeNull()
    expect(readCachedMsk()).toBeNull()
    expect(walletStorage.getItem("obsidion.aaa.obsidion_contacts")).toBe("keep")
    expect(stopPxe).toHaveBeenCalledOnce()
    expect(assign).toHaveBeenCalledWith("/claim")
    expect(stopPxe.mock.invocationCallOrder[0]).toBeLessThan(assign.mock.invocationCallOrder[0])
  })

  it("a store that refuses the removal is reported and nothing reloads", async () => {
    setActiveStorageId("aaa")
    writeCachedMsk({ v: 1, storageId: "aaa", credentialId: "cred-a", msk: `0x${"11".repeat(32)}` })
    await walletStorage.flush()
    testWalletDbs().onApply = () => {
      throw new Error("blocked")
    }
    await logout(stopPxe)
    expect(h.showReportableError).toHaveBeenCalledWith(
      expect.any(Error),
      "identity:logout",
      expect.objectContaining({ message: expect.stringContaining("sign out") }),
    )
    expect(stopPxe).not.toHaveBeenCalled()
    expect(assign).not.toHaveBeenCalled()
  })

  it("reports a PXE shutdown failure and does not reload into a locked store", async () => {
    const failure = new Error("PXE did not stop")
    stopPxe.mockRejectedValueOnce(failure)

    await logout(stopPxe)

    expect(h.showReportableError).toHaveBeenCalledWith(
      failure,
      "identity:logout",
      expect.objectContaining({ message: expect.stringContaining("sign out") }),
    )
    expect(assign).not.toHaveBeenCalled()
  })
})
