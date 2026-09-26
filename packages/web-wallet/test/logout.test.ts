import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ showReportableError: vi.fn(), campaignUrl: "" }))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: h.showReportableError }))
vi.mock("../src/platform/auth/useAuthenticator", () => ({ peekAuthService: () => undefined }))
vi.mock("../src/config/env", () => ({
  getConfig: () => ({ rpId: "localhost", campaignUrl: h.campaignUrl }),
}))
vi.mock("../src/platform/auth/WebPasskeyIdentityMap", () => ({
  hasMskRootBreadcrumb: () => false,
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
    h.campaignUrl = ""
    Object.defineProperty(window, "location", { value: { assign }, writable: true })
  })

  it("clears the active session, stops the PXE, then hard-reloads", async () => {
    saveWalletIdentity({ handle: "@alice", address: "0xa", claimedAt: 1 })
    setActiveStorageId("aaa")
    setActiveCredentialId("cred-a")
    writeCachedMsk({ v: 1, storageId: "aaa", credentialId: "cred-a", msk: `0x${"11".repeat(32)}` })
    localStorage.setItem("obsidion.aaa.obsidion_contacts", "keep")
    await logout(stopPxe)
    expect(loadWalletIdentity()).toBeNull()
    expect(getActiveStorageId()).toBeNull()
    expect(getActiveCredentialId()).toBeNull()
    expect(readCachedMsk()).toBeNull()
    expect(localStorage.getItem("obsidion.aaa.obsidion_contacts")).toBe("keep")
    expect(stopPxe).toHaveBeenCalledOnce()
    // No campaign in this build: the wallet's own route is all there is.
    expect(assign).toHaveBeenCalledWith("/claim")
    expect(stopPxe.mock.invocationCallOrder[0]).toBeLessThan(assign.mock.invocationCallOrder[0])
  })

  it("lands on the campaign signed out of it too, where signing back in starts", async () => {
    h.campaignUrl = "https://launch.test.invalid"
    saveWalletIdentity({ handle: "@alice", address: "0xa", claimedAt: 1 })
    setActiveStorageId("aaa")
    await logout(stopPxe)
    expect(loadWalletIdentity()).toBeNull()
    // The campaign's session is a cookie only that origin can clear, so the URL asks it to.
    expect(assign).toHaveBeenCalledWith("https://launch.test.invalid/?signedout=1")
  })

  it("asks once for a campaign URL that already ends in a slash", async () => {
    h.campaignUrl = "https://launch.test.invalid/"
    setActiveStorageId("aaa")
    await logout(stopPxe)
    expect(assign).toHaveBeenCalledWith("https://launch.test.invalid/?signedout=1")
  })

  it("a store that refuses the removal is reported and nothing reloads", async () => {
    setActiveStorageId("aaa")
    writeCachedMsk({ v: 1, storageId: "aaa", credentialId: "cred-a", msk: `0x${"11".repeat(32)}` })
    const blocked = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    try {
      await logout(stopPxe)
    } finally {
      blocked.mockRestore()
    }
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
