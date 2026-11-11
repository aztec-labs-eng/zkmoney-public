/**
 * Signing out ends the in-memory session at the call, then removes the tuple under the session lock
 * and unbinds the tab only once the store has let it go; the wizard keeps its pointers. Every
 * user-initiated sign-out also clears the tuple out of other rollups' databases.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { signOut } from "../../../src/features/identity/signOut"
import { cachedMsk } from "../../../src/platform/storage/activeStorage"
import { writeDeviceKeys } from "../../../src/platform/storage/deviceKeys"
import {
  closeWalletStore,
  openWalletStore,
  walletStorage,
} from "../../../src/platform/storage/walletStorage"
import { sandboxProfile } from "../../fixtures/sandboxProfile"
import { testWalletDbs } from "../../support/fakeWalletDb"
import { testPage, committed, testCore } from "../../support/page"
import { savedIdentity, setIdentity } from "../../support/identity"

const deviceDb = testPage().database
const lockOut = vi.fn()
const { device, sessionLock } = testCore()
const config = { profileRollupVersion: sandboxProfile().shared.rollupVersion }
const page = { auth: { lockOut }, config, database: deviceDb, device, sessionLock }

const cache = { v: 1 as const, storageId: "s", credentialId: "c", msk: `0x${"11".repeat(32)}` }

/** Another rollup's saved wallet state. */
const other = () => testWalletDbs().db("other").state

const seedOtherSessions = () => {
  other().set("webwallet.msk", "theirs")
  other().set("webwallet.storageId", "sid")
  other().set("webwallet.credentialId", "cred")
  other().set("webwallet.identity", "id")
}

const otherSessionsCleared = () =>
  !other().has("webwallet.msk") &&
  !other().has("webwallet.storageId") &&
  !other().has("webwallet.credentialId")

describe("signOut", () => {
  beforeEach(async () => {
    localStorage.clear()
    lockOut.mockClear()
    // A persistent store: only one clears other rollups' sessions.
    await closeWalletStore()
    await openWalletStore(config.profileRollupVersion, { persistent: true })
    await writeDeviceKeys(deviceDb, {
      storageId: "s",
      credentialId: "c",
      msk: JSON.stringify(cache),
    })
  })

  it("ends the in-memory session at the call, then drops the cache and the pointers", async () => {
    const pending = signOut(page)
    // The fence is synchronous: nothing reads the key back while the lock is pending.
    expect(lockOut).toHaveBeenCalledTimes(1)
    await pending
    expect(cachedMsk(committed())).toBeNull()
    expect(committed().storageId).toBeNull()
    expect(committed().credentialId).toBeNull()
  })

  it("clears the tuple out of every other rollup's database, and nothing else", async () => {
    seedOtherSessions()
    await signOut(page)
    expect(otherSessionsCleared()).toBe(true)
    expect(other().get("webwallet.identity")).toBe("id")
  })

  it("keeping the pointers keeps them; the cache and the identity still go", async () => {
    seedOtherSessions()
    await setIdentity({ handle: "alice" })
    await signOut(page, { keepPointers: true })
    expect(await savedIdentity()).toBeNull()
    expect(cachedMsk(committed())).toBeNull()
    expect(committed().storageId).toBe("s")
    expect(committed().credentialId).toBe("c")
    expect(otherSessionsCleared()).toBe(true)
    expect(lockOut).toHaveBeenCalledTimes(1)
  })

  it("clears under the session lock, so a commit landing while it waits goes too", async () => {
    seedOtherSessions()
    let release!: () => void
    const held = testCore().sessionLock(() => new Promise<void>((resolve) => (release = resolve)))
    const pending = signOut(page)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(lockOut).toHaveBeenCalledTimes(1)
    expect(other().get("webwallet.msk")).toBe("theirs")
    await writeDeviceKeys(deviceDb, { storageId: "s", credentialId: "c" })
    await writeDeviceKeys(deviceDb, {
      msk: JSON.stringify({ ...cache, credentialId: "committed" }),
    })
    other().set("webwallet.credentialId", "committed")
    release()
    await held
    await pending
    expect(cachedMsk(committed())).toBeNull()
    expect(committed().storageId).toBeNull()
    expect(committed().credentialId).toBeNull()
    expect(otherSessionsCleared()).toBe(true)
  })

  it("a local-only sign-out leaves other rollups' databases alone", async () => {
    seedOtherSessions()
    await signOut(page, { keepPointers: true, localOnly: true })
    expect(cachedMsk(committed())).toBeNull()
    expect(committed().storageId).toBe("s")
    expect(other().get("webwallet.msk")).toBe("theirs")
  })

  it("a removal that fails keeps the whole session, and a retry finishes the job", async () => {
    await setIdentity({ handle: "alice" })
    await walletStorage.flush()
    let refuseOnce = true
    testWalletDbs().onApply = () => {
      if (refuseOnce) {
        refuseOnce = false
        throw new Error("blocked")
      }
    }
    await expect(signOut(page)).rejects.toThrow(/blocked/)
    expect((await savedIdentity())?.handle).toBe("alice")
    expect(cachedMsk(committed())).not.toBeNull()
    expect(committed().storageId).toBe("s")
    expect(committed().credentialId).toBe("c")
    await signOut(page)
    expect(cachedMsk(committed())).toBeNull()
    expect(committed().storageId).toBeNull()
    expect(committed().credentialId).toBeNull()
    expect(lockOut).toHaveBeenCalledTimes(2)
  })
})
