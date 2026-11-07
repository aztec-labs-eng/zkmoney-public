import { afterEach, describe, expect, it } from "vitest"
import { testPage, testCore } from "../support/page"
import { createAccountRecord } from "@obsidion/front-core"
import { AUTH_TYPE } from "@obsidion/sdk"
import { pageSessionDeps } from "../../src/app/sessionDeps"
import {
  activeNamespace,
  closeSession,
  namespaceOf,
  signedInAccount,
  switchSession,
} from "../../src/session/session"
import { writeDeviceKeys } from "../../src/platform/storage/deviceKeys"

const deviceDb = testPage().database

const account = (address: string) => ({
  completeAddress: address,
  signKeyConfig: {
    type: AUTH_TYPE.WEB_AUTHN,
    webauthnData: { credentialId: address, pubkey: "p" },
  },
})

afterEach(closeSession)

describe("signedInAccount", () => {
  it("saves a sign-in that committed another account to that account, not the open one", async () => {
    await writeDeviceKeys(deviceDb, { storageId: "account-a" })
    const open = switchSession(activeNamespace(testCore().device), pageSessionDeps(testPage()))
    await open.accountRecord!.save(account("0xa"))
    // B commits; the page serves A until it switches.
    await writeDeviceKeys(deviceDb, { storageId: "account-b" })
    await signedInAccount().save(account("0xb"))

    expect(await open.accountRecord!.get()).toMatchObject({ completeAddress: "0xa" })
    const b = createAccountRecord({ db: deviceDb.scoped(namespaceOf("account-b").prefix) })
    expect(await b.get()).toMatchObject({ completeAddress: "0xb" })
  })
})
