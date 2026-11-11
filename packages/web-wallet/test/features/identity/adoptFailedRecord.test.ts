/** A recovered account saved over a record that failed to open, and the session it goes on in. */
import { afterEach, describe, expect, it } from "vitest"
import type { ObsidionAccount, ObsidionWallet } from "@obsidion/sdk"
import { pageSessionDeps } from "../../../src/app/sessionDeps"
import { adoptRecoveredAccount } from "../../../src/features/identity/passkeyAccount"
import { writeDeviceKeys } from "../../../src/platform/storage/deviceKeys"
import {
  activeNamespace,
  closeSession,
  namespaceOf,
  openedSession,
  switchSession,
} from "../../../src/session/session"
import { testPage } from "../../support/page"
import { sessionPage } from "../../support/session"

const deviceDb = testPage().database
const account = {
  getCompleteAddress: () => ({ toString: () => "0xa" }),
} as unknown as ObsidionAccount
const wallet = { createObsidionAccount: async () => account } as unknown as ObsidionWallet
const auth = {
  recordRecoveryMetadata: async () => {},
  sessionAddress: async () => undefined,
  commitSecret: async () => 1,
  sessionHeld: () => true,
  markRecordsStale: () => {},
}
const recovered = { credentialId: "c", pubkey: "p", authProvider: {}, passkeys: ["p"] }

afterEach(closeSession)

describe("adoptRecoveredAccount", () => {
  it.each([
    ["goes on in the open session over a record that loaded", undefined, false],
    ["goes on in a new session over a record that failed to open, which reads the save", "x", true],
  ])("%s", async (_, blob, replaced) => {
    await writeDeviceKeys(deviceDb, { storageId: "account-a" })
    const db = deviceDb.scoped(namespaceOf("account-a").prefix)
    if (blob) await db.write(async (w) => w.put("obsidion_accounts", blob))
    const page = sessionPage(auth)
    const open = switchSession(activeNamespace(page.device), pageSessionDeps(page))
    await Promise.allSettled([open.accountRecord!.get()])

    const { session } = await adoptRecoveredAccount(
      wallet,
      { session: open, accounts: () => openedSession.get()!.accountRecord! },
      recovered as never,
      {} as never,
      "first",
      "0xa",
      new AbortController().signal,
    )

    expect(session !== open).toBe(replaced)
    expect(openedSession.get()).toBe(session)
    expect(await session.accountRecord!.get()).toMatchObject({ completeAddress: "0xa" })
  })
})
