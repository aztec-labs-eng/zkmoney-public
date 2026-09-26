/**
 * Signing out ends the in-memory session at the call, then removes the tuple under the session lock
 * and unbinds the tab only once the store has let it go; the wizard keeps its pointers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ lockOut: vi.fn() }))
vi.mock("../src/platform/auth/useAuthenticator", () => ({
  peekAuthService: () => ({ lockOut: h.lockOut }),
}))

const { signOut } = await import("../src/features/identity/signOut")
const {
  getActiveCredentialId,
  getActiveStorageId,
  readCachedMsk,
  setActiveCredentialId,
  setActiveStorageId,
  writeCachedMsk,
} = await import("../src/platform/storage/activeStorage")

const cache = { v: 1 as const, storageId: "s", credentialId: "c", msk: `0x${"11".repeat(32)}` }

describe("signOut", () => {
  beforeEach(() => {
    localStorage.clear()
    h.lockOut.mockClear()
    setActiveStorageId("s")
    setActiveCredentialId("c")
    writeCachedMsk(cache)
  })

  it("ends the in-memory session at the call, then drops the cache and the pointers", async () => {
    const pending = signOut()
    // The fence is synchronous: nothing reads the key back while the lock is pending.
    expect(h.lockOut).toHaveBeenCalledTimes(1)
    await pending
    expect(readCachedMsk()).toBeNull()
    expect(getActiveStorageId()).toBeNull()
    expect(getActiveCredentialId()).toBeNull()
  })

  it("keeping the pointers keeps them; the cache still goes", async () => {
    await signOut({ keepPointers: true })
    expect(readCachedMsk()).toBeNull()
    expect(getActiveStorageId()).toBe("s")
    expect(getActiveCredentialId()).toBe("c")
    expect(h.lockOut).toHaveBeenCalledTimes(1)
  })

  it("a removal that fails half-way keeps the pointers, and a retry finishes the job", async () => {
    const original = Storage.prototype.removeItem
    let refuseOnce = true
    const blocked = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(function (this: Storage, key: string) {
        if (refuseOnce && key === "webwallet.msk") {
          refuseOnce = false
          throw new Error("blocked")
        }
        return original.call(this, key)
      })
    try {
      await expect(signOut()).rejects.toThrow(/blocked/)
      expect(readCachedMsk()).not.toBeNull()
      expect(getActiveStorageId()).toBe("s")
      expect(getActiveCredentialId()).toBe("c")
      await signOut()
    } finally {
      blocked.mockRestore()
    }
    expect(readCachedMsk()).toBeNull()
    expect(getActiveStorageId()).toBeNull()
    expect(getActiveCredentialId()).toBeNull()
    expect(h.lockOut).toHaveBeenCalledTimes(2)
  })

  it("a store that refuses still ends the in-memory session, and leaves the pointers it kept", async () => {
    const blocked = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    try {
      await expect(signOut()).rejects.toThrow(/blocked/)
    } finally {
      blocked.mockRestore()
    }
    expect(h.lockOut).toHaveBeenCalledTimes(1)
    expect(getActiveStorageId()).toBe("s")
    expect(getActiveCredentialId()).toBe("c")
  })
})
