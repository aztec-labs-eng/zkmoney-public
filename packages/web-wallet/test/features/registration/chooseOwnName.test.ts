// A name of the user's own claimed over the registration still owed its deposit.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PendingRegistrationRecord } from "@obsidion/front-core"
import { claimWith } from "../../../src/features/onboarding/oxideOnboarding"
import { chooseOwnName, type ClaimOver } from "../../../src/features/registration/chooseOwnName"
import { usertagFor } from "../../../src/platform/auth/WebPasskeyIdentityMap"
import { savedIdentity, setIdentity } from "../../support/identity"
import { closeSession, type Session } from "../../../src/session/session"
import { openTestSession } from "../../support/session"
import { seedDeviceKeys, committed, defaultConfig } from "../../support/page"
import { accountRecords, nameClaim } from "../../support/registrationFixtures"
import { HASH, L2, NEW, OLD, OWNER, TOKEN, claimHarness } from "../../support/claimHarness"

const authProvider = { getPubkeys: async () => [Buffer.alloc(32, 1), Buffer.alloc(32, 2)] }
const account = {
  getAddress: () => ({ toString: () => L2 }),
  getAuthProvider: () => authProvider,
} as never
const DRAWN = "brave-otter-42"

let session: Session
/** The claim the sheet runs, over the test session's stores. */
let over: ClaimOver

async function seed(patch: Partial<PendingRegistrationRecord> = {}) {
  const record: Omit<PendingRegistrationRecord, "account"> = {
    tag: DRAWN,
    nameHash: HASH,
    l2Address: L2,
    l1ChainId: 11155111,
    sipaAddress: OLD,
    fee: "1",
    beneficiary: OWNER,
    depositToken: TOKEN,
    broadcast: false,
    phase: "awaiting_deposit",
    retries: 0,
    startTime: Date.now(),
  }
  await accountRecords.upsert(OWNER, patch, record)
  await setIdentity({ handle: DRAWN, address: L2, claimedAt: 1, pending: true })
}
const choose = () => chooseOwnName(session, "river", account, over)
const keptDrawn = async () => {
  expect(accountRecords.current()?.sipaAddress).toBe(OLD)
  expect((await savedIdentity())?.handle).toBe(DRAWN)
}
beforeEach(async () => {
  localStorage.clear()
  await seedDeviceKeys({ storageId: "a1" })
  session = openTestSession({
    auth: { sessionKeys: async () => ({ secretKey: 1n, authProvider }) },
  })
  await session.registrations.ready
  const harness = claimHarness(session, "river")
  harness.h.sign.mockResolvedValue(nameClaim())
  over = (tag, keys, replaced) =>
    claimWith(harness.deps, { handle: tag, keys, replacedRecord: replaced, ticket: null })
})
afterEach(closeSession)

describe("chooseOwnName", () => {
  it("claims the new name at a new address over the unfunded registration, and presents it", async () => {
    await seed()
    await choose()
    expect(accountRecords.current()).toMatchObject({ tag: "river", sipaAddress: NEW })
    expect(accountRecords.current()?.replaced).toMatchObject({ sipaAddress: OLD })
    expect(await savedIdentity()).toMatchObject({ handle: "river", pending: true })
  })

  it("renames the passkey under the handle it was created with and remembers the new name", async () => {
    await seed()
    const { rpId } = defaultConfig
    await seedDeviceKeys({
      credentialId: "cred-1",
      passkeyMap: JSON.stringify({
        version: 1,
        entries: { "cred-1": { credentialId: "cred-1", rpId, userHandle: "YQAB" } },
      }),
    })
    const signalCurrentUserDetails = vi.fn(async () => {})
    vi.stubGlobal("PublicKeyCredential", { signalCurrentUserDetails })
    await choose()
    vi.unstubAllGlobals()
    expect(signalCurrentUserDetails).toHaveBeenCalledWith({
      rpId,
      userId: "YQAB",
      name: "river",
      displayName: "river",
    })
    expect(usertagFor(committed().passkeyMap, rpId, "cred-1")).toBe("river")
  })

  it("refuses once the tag is confirmed and its address broadcast", async () => {
    await seed({ broadcast: true })
    await expect(choose()).rejects.toMatchObject({ code: "registration.nameConfirmed" })
    await keptDrawn()
  })

  it("refuses once the first deposit has reached the address", async () => {
    await seed({ fundedAt: Date.now() })
    await expect(choose()).rejects.toMatchObject({ code: "registration.nameLocked" })
    await keptDrawn()
  })

  it("reads the burns before it decides: a ticket's burn to the address keeps the name", async () => {
    await seed()
    await session.withdrawals.create({
      networkId: "0xnet",
      localId: "w1",
      recipient: OLD,
      recipientProvenance: "saved-recipient",
      amount: "5",
      tokenSymbol: "DAI",
      tokenDecimals: 18,
      phase: "submitting",
      startTime: 1,
    })
    // A reload: the page's withdrawals have yet to load when the tap lands.
    closeSession()
    session = openTestSession()
    expect(session.withdrawals.list.get().hydrated).toBe(false)
    await session.registrations.ready
    await expect(choose()).rejects.toMatchObject({ code: "registration.nameLocked" })
    await keptDrawn()
  })
})
