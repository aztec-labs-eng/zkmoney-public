/**
 * A reload at any point in a backup re-root keeps the session: the cached key's check needs the
 * session's record and the saved account to name the same address, and the re-root saves the two
 * in one write once the two-key account is built. A sign-out during it saves nothing.
 */
import { Fr } from "@aztec-labs/aztec.js/fields"
import { createAccountRecord } from "@obsidion/front-core"
import type { ObsidionAccount } from "@obsidion/sdk"
import { afterEach, describe, expect, it } from "vitest"
import { pageSessionDeps } from "../../../src/app/sessionDeps"
import { rerootDeps } from "../../../src/features/backupPasskey/backupPasskeyRuntime"
import { rerootToPasskeySet } from "../../../src/features/backupPasskey/rerootToPasskeySet"
import { signOut } from "../../../src/features/identity/signOut"
import { walletAuth } from "../../../src/platform/auth/useAuthenticator"
import type { WebAlphaAuthService } from "../../../src/platform/auth/WebAlphaAuthService"
import { DEVICE_KEYS } from "../../../src/platform/storage/deviceKeys"
import { saveIdentity } from "../../../src/session/account"
import {
  activeNamespace,
  closeSession,
  switchSession,
  type Session,
} from "../../../src/session/session"
import { TWO_KEY, signedRecord, word } from "../../support/backupAdd"
import { testWalletDbs } from "../../support/fakeWalletDb"
import { savedIdentity } from "../../support/identity"
import { testAuth, testCore, testPage } from "../../support/page"

const dbs = testWalletDbs()
const ACCOUNT_KEY = "acct/account/current"
const ONE_KEY = word(0x1a)
// The first passkey the signed change names: a re-root refuses any other session.
const ROOT = `${word(14).slice(2)}${word(15).slice(2)}`
const CRED = "root-credential"
const msk = Fr.random()

const derive = async (_msk: Fr, passkeys: readonly string[]) =>
  passkeys.length === 2 ? TWO_KEY : ONE_KEY

const twoKeyAccount = {
  getAddress: () => ({ toString: () => TWO_KEY }),
  getCompleteAddress: () => ({ toString: () => TWO_KEY }),
} as unknown as ObsidionAccount

/** The page's auth service as the wallet wires it, reading the committed account's record. */
const service = () =>
  walletAuth(testAuth(), { deriveAccountAddress: derive } as never, () =>
    createAccountRecord({
      db: testCore().database.scoped(activeNamespace(testCore().device).prefix),
      now: () => Date.now(),
    }),
  )

/** A one-key session as a sign-in leaves it: the key cached, the record, account and identity saved. */
async function signedIn() {
  const auth = service()
  await auth.commitSecret({
    secretKey: msk,
    authProvider: auth.providerFor({ credentialId: CRED, pubkeyHex: ROOT, passkeys: [ROOT] }),
  })
  await auth.recordRecoveryMetadata({
    credentialId: CRED,
    l2Address: ONE_KEY,
    pubkey: ROOT,
    isMskRoot: true,
    prfSlot: "first",
    authenticatorType: "platform",
  })
  const page = testPage(auth)
  const session = switchSession(activeNamespace(page.device), pageSessionDeps(page))
  await session.accountRecord!.apply({
    type: "saved",
    completeAddress: ONE_KEY,
    signer: { credentialId: CRED, pubkey: ROOT },
  })
  await saveIdentity(page, { handle: "alice", address: ONE_KEY, claimedAt: 1 })
  return { auth, session }
}

/** A held step: `reached` resolves when the re-root gets there; it waits for `release`. */
function gate() {
  let reach!: () => void
  let release!: () => void
  const reached = new Promise<void>((resolve) => (reach = resolve))
  const released = new Promise<void>((resolve) => (release = resolve))
  return { reached, release, pass: () => (reach(), released) }
}

/** The runtime's re-root over this session, with the account build and the commit held. */
function reroot(session: Session) {
  const build = gate()
  const commit = gate()
  const wallet = {
    deriveAccountAddress: derive,
    createObsidionAccount: async () => {
      await build.pass()
      return twoKeyAccount
    },
  }
  const deps = rerootDeps({
    session,
    wallet: wallet as never,
    secretKey: msk,
    oneKeyAddress: ONE_KEY,
    root: { credentialId: CRED, pubkeyHex: ROOT },
    switchAccount: () => {},
  })
  const commitSigner = deps.commit
  deps.commit = async (provider) => {
    await commit.pass()
    return commitSigner(provider)
  }
  const run = () => rerootToPasskeySet(deps, signedRecord({ phase: "swept" }), async () => {})
  return { deps, build, commit, run }
}

/** What a reloaded page restores from what is saved: the session's address, if it kept one. */
async function reload(): Promise<string | undefined> {
  const page = service()
  return (await page.sessionKeys()) ? page.sessionAddress() : undefined
}

const identityAddress = async () => (await savedIdentity())?.address

/** The keys of every write saved from now on. */
function savedKeys(): string[] {
  const keys: string[] = []
  dbs.onApply = (_version, ops) => void keys.push(...ops.map(([key]) => key))
  return keys
}

const rerootWrite = (key: string) => key === DEVICE_KEYS.passkeyMap || key.endsWith(ACCOUNT_KEY)

afterEach(closeSession)

describe("a reload during a backup re-root", () => {
  it("keeps the one-key session while the two-key account builds, and the two-key one once saved", async () => {
    const { session } = await signedIn()
    const { build, commit, run } = reroot(session)
    const rerooted = run()

    await build.reached
    expect(await reload()).toBe(ONE_KEY)

    build.release()
    await commit.reached
    expect(await reload()).toBe(TWO_KEY)
    expect(await identityAddress()).toBe(ONE_KEY)

    commit.release()
    await rerooted
    expect(await reload()).toBe(TWO_KEY)
    expect(await identityAddress()).toBe(TWO_KEY)
    expect(testCore().device.get().credentialId).toBe(CRED)
  })

  it("saves both records and the account in one write, so one that never lands keeps the one-key session", async () => {
    const { session } = await signedIn()
    const failed: string[][] = []
    const unloaded = new Error("page unloaded")
    dbs.onApply = (_version, ops) => {
      if (!ops.some(([key]) => key.endsWith(ACCOUNT_KEY))) return
      failed.push(ops.map(([key]) => key))
      throw unloaded
    }
    const { build, run } = reroot(session)
    build.release()

    await expect(run()).rejects.toBe(unloaded)
    expect(failed).toHaveLength(1)
    expect(failed[0]).toContain(DEVICE_KEYS.passkeyMap)

    dbs.onApply = undefined
    expect(await reload()).toBe(ONE_KEY)
  })
})

describe("a sign-out during a backup re-root", () => {
  const signOutOf = (auth: WebAlphaAuthService) => signOut(testPage(auth), { localOnly: true })

  /** What a re-root saves when a sign-out lands at `when`; the build and the commit run through. */
  async function savedAroundSignOut(when: "before" | "begun" | "derive" | "save" | "reads") {
    const { auth, session } = await signedIn()
    const { deps, build, commit, run } = reroot(session)
    build.release()
    commit.release()
    let signingOut: Promise<void> | undefined
    if (when === "before") await signOutOf(auth)
    // A sign-out drops the key before its cleanup saves the cleared pointers.
    if (when === "begun") auth.lockOut()
    if (when === "derive") {
      const deriveSet = deps.derive
      deps.derive = async (set) => {
        await signOutOf(auth)
        return deriveSet(set)
      }
    }
    if (when === "reads") {
      const stage = auth.stageRecoveryMetadata.bind(auth)
      auth.stageRecoveryMetadata = async (w, metas) => {
        await stage(w, metas)
        signingOut = signOutOf(auth)
      }
    }
    if (when === "save") {
      const persist = deps.persist
      deps.persist = (account, records, held) => {
        signingOut = signOutOf(auth)
        return persist(account, records, held)
      }
    }
    const saved = savedKeys()
    await expect(run()).rejects.toMatchObject({ code: "aborted" })
    await signingOut
    return saved.filter(rerootWrite)
  }

  it("saves nothing when it landed before the re-root began", async () => {
    expect(await savedAroundSignOut("before")).toEqual([])
  })

  it("saves nothing when it began before the re-root and is still clearing up", async () => {
    expect(await savedAroundSignOut("begun")).toEqual([])
  })

  it("saves nothing when it lands while the two-key address derives", async () => {
    expect(await savedAroundSignOut("derive")).toEqual([])
  })

  it("saves nothing when it lands while the save waits to write", async () => {
    expect(await savedAroundSignOut("save")).toEqual([])
  })

  it("saves nothing when it lands while the save reads what it changes", async () => {
    expect(await savedAroundSignOut("reads")).toEqual([])
  })
})
