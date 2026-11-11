import { afterEach, describe, expect, it } from "vitest"
import { LEGACY_IDENTITY_KEY } from "@obsidion/front-core"
import { pageSessionDeps } from "../../src/app/sessionDeps"
import { enteredIdentity } from "../../src/session/account"
import {
  closeSession,
  followSavedSession,
  namespaceOf,
  openedSession,
  switchSession,
} from "../../src/session/session"
import { bootWaitsForStart } from "../../src/ui/PxeBoot"
import { testWalletDbs } from "../support/fakeWalletDb"
import { seedDeviceKeys, testCore, testPage } from "../support/page"

const ADDRESS = `0x${"1d".repeat(32)}`
const LEGACY = { handle: "taga", address: ADDRESS, claimedAt: 1 }
const passkeyFor = (l2Address: string) =>
  JSON.stringify({
    version: 1,
    entries: { cred: { rpId: "localhost", l2Address, isMskRoot: true, createdAt: 1 } },
  })

/** An older build's signed-in device: its pointers, its passkey and its identity. */
async function signedIn(passkeyAddress = ADDRESS) {
  await seedDeviceKeys({
    storageId: "acct-a",
    credentialId: "cred",
    passkeyMap: passkeyFor(passkeyAddress),
  })
  await testCore().database.write(async (w) => w.put(LEGACY_IDENTITY_KEY, JSON.stringify(LEGACY)))
}

/** Holds the identity's first open until released; `fail` makes it fail instead. */
function holdIdentityOpen(fail = false) {
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  testWalletDbs().onApply = async (_version, ops) => {
    if (!ops.some(([key]) => key.includes("acct/meta/identity"))) return
    if (fail) throw new Error("disk")
    await held
  }
  return release
}

const follow = () => followSavedSession(testCore().device, pageSessionDeps(testPage()))
afterEach(closeSession)

describe("the session's identity", () => {
  it("is loaded before an account switch makes its session current", async () => {
    const visitor = switchSession(namespaceOf(null), pageSessionDeps(testPage()))
    await signedIn()
    const release = holdIdentityOpen()
    const following = follow()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(openedSession.get()).toBe(visitor)

    release()
    await following
    const open = openedSession.get()!
    expect(open.namespace.id).toBe("acct-a")
    expect(open.identity.get()).toEqual({ value: LEGACY, loaded: true, failed: false })
  })

  it("carries no legacy identity whose address another account's passkey opened", async () => {
    switchSession(namespaceOf(null), pageSessionDeps(testPage()))
    await signedIn(`0x${"2e".repeat(32)}`)
    await follow()
    expect(openedSession.get()?.identity.get()).toMatchObject({ value: null, loaded: true })
  })

  it("waits for a slow identity when the registrations fail to open, and reads it unloaded as unknown", async () => {
    switchSession(namespaceOf(null), pageSessionDeps(testPage()))
    await signedIn()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    testWalletDbs().onApply = async (_version, ops) => {
      if (ops.some(([key]) => key.includes("acct/meta/registrations"))) throw new Error("disk")
      if (ops.some(([key]) => key.includes("acct/meta/identity"))) await held
    }
    const following = follow()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(openedSession.get()?.namespace.id).toBeNull()
    const unloaded = { value: null, loaded: false, failed: false }
    expect(enteredIdentity(unloaded, passkeyFor(ADDRESS), "localhost")).toBeUndefined()
    release()
    await following
    const { identity, device } = openedSession.get()!
    expect(enteredIdentity(identity.get(), device.get().passkeyMap, "localhost")).toEqual(LEGACY)
  })

  it("reads a failed load as unknown, never as onboarding", async () => {
    switchSession(namespaceOf(null), pageSessionDeps(testPage()))
    await signedIn()
    holdIdentityOpen(true)
    await follow()
    const { identity, device } = openedSession.get()!
    expect(identity.get()).toMatchObject({ failed: true })
    expect(enteredIdentity(identity.get(), device.get().passkeyMap, "localhost")).toBeUndefined()
    expect(bootWaitsForStart(identity.get(), "/pay/river")).toBe(false)
  })
})
