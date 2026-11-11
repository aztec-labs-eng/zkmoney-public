import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { walletStorage } from "../../../src/platform/storage/walletStorage"
import { testWalletDbs } from "../../support/fakeWalletDb"
import { openTestSession } from "../../support/session"
import { closeSession, openedSession } from "../../../src/session/session"

import { type ErrorModalPayload, subscribeErrorModal } from "../../../src/errors/errorModal"
import { logout } from "../../../src/features/identity/logout"
import { setIdentity, savedIdentity } from "../../support/identity"
import { cachedMsk } from "../../../src/platform/storage/activeStorage"
import { writeDeviceKeys } from "../../../src/platform/storage/deviceKeys"
import { testPage, committed } from "../../support/page"

const page = testPage(undefined, { profileRollupVersion: "r" } as never)
const deviceDb = page.database
const CACHE = JSON.stringify({
  v: 1,
  storageId: "aaa",
  credentialId: "cred-a",
  msk: `0x${"11".repeat(32)}`,
})

describe("logout", () => {
  const assign = vi.fn()
  const stopPxe = vi.fn(async () => {})
  const reports: ErrorModalPayload[] = []
  let unsubscribe = () => {}
  beforeEach(() => {
    localStorage.clear()
    assign.mockClear()
    stopPxe.mockClear()
    reports.length = 0
    unsubscribe = subscribeErrorModal((payload) => reports.push(payload))
    Object.defineProperty(window, "location", { value: { assign }, writable: true })
  })
  afterEach(() => unsubscribe())

  it("clears the active session, stops the PXE, then hard-reloads", async () => {
    await writeDeviceKeys(deviceDb, { storageId: "aaa", credentialId: "cred-a", msk: CACHE })
    await setIdentity({ handle: "@alice", address: "0xa", claimedAt: 1 })
    walletStorage.setItem("obsidion.aaa.obsidion_contacts", "keep")
    stopPxe.mockImplementationOnce(async () => void expect(page.leaving.get()).toBe(true))
    await logout(page, stopPxe)
    expect(await savedIdentity("aaa")).toBeNull()
    expect(committed().storageId).toBeNull()
    expect(committed().credentialId).toBeNull()
    expect(cachedMsk(committed())).toBeNull()
    expect(walletStorage.getItem("obsidion.aaa.obsidion_contacts")).toBe("keep")
    expect(stopPxe).toHaveBeenCalledOnce()
    expect(assign).toHaveBeenCalledWith("/claim")
    expect(stopPxe.mock.invocationCallOrder[0]).toBeLessThan(assign.mock.invocationCallOrder[0])
  })

  it("keeps a session for every read until the page leaves", async () => {
    await writeDeviceKeys(deviceDb, { storageId: "aaa" })
    const open = openTestSession()
    const reads: unknown[] = []
    const stop = openedSession.subscribe(() => {
      try {
        reads.push(openedSession.get())
      } catch (e) {
        reads.push(e)
      }
    })
    await logout(page, stopPxe)
    stop()
    expect(assign).toHaveBeenCalledWith("/claim")
    expect(reads.every((read) => read === open)).toBe(true)
    expect(openedSession.get()).toBe(open)
    closeSession()
  })

  it("stops the session's work before the PXE, so no task runs against a stopped PXE", async () => {
    await writeDeviceKeys(deviceDb, { storageId: "aaa" })
    const open = openTestSession()
    const pending = Symbol("pending")
    let stopped: boolean | symbol = pending
    stopPxe.mockImplementationOnce(async () => {
      const waits = open.milestones.after({ firstBalance: true })
      const later = new Promise<symbol>((resolve) => setTimeout(() => resolve(pending), 0))
      stopped = await Promise.race([waits, later])
    })
    await logout(page, stopPxe)
    expect(stopped).toBe(false)
    closeSession()
  })

  it("a store that refuses the removal is reported and nothing reloads", async () => {
    await writeDeviceKeys(deviceDb, { storageId: "aaa", msk: CACHE })
    await walletStorage.flush()
    testWalletDbs().onApply = () => {
      throw new Error("blocked")
    }
    await logout(page, stopPxe)
    expect(page.leaving.get()).toBe(false)
    expect(reports).toEqual([
      expect.objectContaining({
        context: "identity:logout",
        detail: expect.stringContaining("blocked"),
      }),
    ])
    expect(stopPxe).not.toHaveBeenCalled()
    expect(assign).not.toHaveBeenCalled()
  })

  it("holds the signed-out page on a PXE shutdown failure, and its retry finishes the exit", async () => {
    await writeDeviceKeys(deviceDb, { storageId: "aaa", msk: CACHE })
    const failure = new Error("PXE did not stop")
    stopPxe.mockRejectedValueOnce(failure)

    await logout(page, stopPxe)

    expect(committed().storageId).toBeNull()
    expect(page.leaving.get()).toBe(true)
    expect(reports).toEqual([
      expect.objectContaining({ context: "identity:logout", detail: failure.stack }),
    ])
    expect(assign).not.toHaveBeenCalled()

    reports[0]!.retry!.run()
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith("/claim"))
    expect(stopPxe).toHaveBeenCalledTimes(2)
    expect(page.leaving.get()).toBe(true)
  })
})
