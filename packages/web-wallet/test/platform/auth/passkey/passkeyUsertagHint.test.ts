/**
 * The usertag hint: the passkey's breadcrumb carries the claimed tag, so the /enter path can
 * name a recovered claim (whose plaintext exists nowhere on-chain) without asking for it again.
 * The hint must survive what clears the identity record — logout, account switching, a later
 * re-recording of the same credential — and must stay scoped to its RP.
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest"
import {
  WebPasskeyIdentityMap,
  rememberUsertag,
  usertagFor,
} from "../../../../src/platform/auth/WebPasskeyIdentityMap"
import { saveIdentity } from "../../../../src/session/account"
import { writeDeviceKeys } from "../../../../src/platform/storage/deviceKeys"
import { NO_SESSION, writeSessionTuple } from "../../../../src/platform/storage/activeStorage"
import { openTestSession } from "../../../support/session"
import { setIdentity } from "../../../support/identity"
import { testPage, committed } from "../../../support/page"

const deviceDb = testPage().database

/** The sandbox profile's RP. */
const RP = "localhost"

const CREDENTIAL = "cred-1"

function map(rpId = RP) {
  return new WebPasskeyIdentityMap(deviceDb, rpId)
}

async function seedBreadcrumb(rpId = RP) {
  await map(rpId).upsert({
    credentialId: CREDENTIAL,
    l2Address: "0x" + "11".repeat(32),
    pubkey: "ab".repeat(64),
    isMskRoot: true,
  })
}

describe("usertag hint", () => {
  beforeEach(async () => {
    localStorage.clear()
    await writeDeviceKeys(deviceDb, { storageId: "s", credentialId: CREDENTIAL })
    openTestSession()
  })

  it("survives logout and a later re-recording of the same credential", async () => {
    await seedBreadcrumb()
    await saveIdentity(testPage(), { handle: "alice", address: "0x1", claimedAt: 1 })
    await setIdentity(null)
    await writeSessionTuple(deviceDb, NO_SESSION)
    await seedBreadcrumb() // what /enter's adopt step does
    expect(usertagFor(committed().passkeyMap, RP, CREDENTIAL)).toBe("alice")
  })

  it("is not written for a pending claim, which can still lose the name race", async () => {
    await seedBreadcrumb()
    await saveIdentity(testPage(), { handle: "alice", address: "0x1", claimedAt: 1, pending: true })
    expect(usertagFor(committed().passkeyMap, RP, CREDENTIAL)).toBeUndefined()
  })

  it("is untouched by a later nameless save", async () => {
    await seedBreadcrumb()
    await saveIdentity(testPage(), { handle: "alice", address: "0x1", claimedAt: 1 })
    await saveIdentity(testPage(), { address: "0x1", claimedAt: 2 })
    expect(usertagFor(committed().passkeyMap, RP, CREDENTIAL)).toBe("alice")
  })

  it("is not written when the sign-in saving the identity has ended", async () => {
    await seedBreadcrumb()
    await saveIdentity(testPage(), { handle: "alice", address: "0x1", claimedAt: 1 }, () => false)
    expect(usertagFor(committed().passkeyMap, RP, CREDENTIAL)).toBeUndefined()
  })

  it("is invisible under another RP", async () => {
    await seedBreadcrumb("obsidion.xyz")
    await rememberUsertag(deviceDb, "obsidion.xyz", CREDENTIAL, "alice")
    expect(usertagFor(committed().passkeyMap, RP, CREDENTIAL)).toBeUndefined()
    expect(usertagFor(committed().passkeyMap, "obsidion.xyz", CREDENTIAL)).toBe("alice")
  })

  it("is absent on a browser with no breadcrumb for the credential", async () => {
    await rememberUsertag(deviceDb, RP, CREDENTIAL, "alice")
    expect(usertagFor(committed().passkeyMap, RP, CREDENTIAL)).toBeUndefined()
  })
})
