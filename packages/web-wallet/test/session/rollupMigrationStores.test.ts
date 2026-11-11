import { afterEach, describe, expect, it, vi } from "vitest"
import { pageSessionDeps } from "../../src/app/sessionDeps"
import { getOldVersionWithdrawalStore } from "../../src/features/withdraw/oldVersionWithdrawals"
import { writeDeviceKeys } from "../../src/platform/storage/deviceKeys"
import {
  closeWalletStore,
  openWalletStore,
  walletStorage,
} from "../../src/platform/storage/walletStorage"
import { activeNamespace, closeSession, switchSession } from "../../src/session/session"
import { sandboxProfile } from "../fixtures/sandboxProfile"
import { reloadDevice, testCore, testPage } from "../support/page"

afterEach(() => {
  closeSession()
  vi.restoreAllMocks()
})

const withdrawal = {
  id: "w1",
  startTime: 1,
  to: "0x1",
  feeUsd: "0",
  fromBlock: "0",
  refunds: [],
  phase: "done",
}

describe("the rollup migration's page-wide stores", () => {
  // Runs first: the page-wide store loads once per module.
  it("load an account's old-version withdrawals when the page was built before the wallet store opened", async () => {
    await closeWalletStore()
    const page = testPage()
    await openWalletStore(sandboxProfile().shared.rollupVersion, { persistent: false })
    await reloadDevice()
    await walletStorage.commitItem(
      "obsidion.account-a.@obsidion/migration/old-version-withdrawals",
      JSON.stringify({ w1: withdrawal }),
    )
    await writeDeviceKeys(testCore().database, { storageId: "account-a" })

    const session = switchSession(activeNamespace(testCore().device), pageSessionDeps(page))

    await vi.waitFor(() =>
      expect(session.feedBase.get().oldVersionWithdrawals).toMatchObject([{ id: "w1" }]),
    )
  })

  it("are mirrored once per page: a session adds no listener to the page-wide store", async () => {
    await writeDeviceKeys(testCore().database, { storageId: "account-a" })
    const deps = pageSessionDeps(testPage())
    const listen = vi.spyOn(getOldVersionWithdrawalStore(), "onListChanged")
    for (let i = 0; i < 2; i++) {
      switchSession(activeNamespace(testCore().device), deps).feedBase.get()
      closeSession()
    }
    expect(listen).toHaveBeenCalledOnce()
  })
})
