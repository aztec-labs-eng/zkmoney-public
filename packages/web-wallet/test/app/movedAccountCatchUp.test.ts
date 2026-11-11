// @vitest-environment node
/**
 * The boot catch-up: a session opened from its cached key adopts the two-key account a backup add on
 * another device moved the wallet to, and nothing else moves it.
 */
import { Fr } from "@aztec-labs/aztec.js/fields"
import { createPace } from "@obsidion/core/cadence"
import {
  deriveBootstrapKey,
  memoryBackend,
  memoryStore,
  openDatabase,
  startRuntime,
  type BackupRotationRecord,
  type OxideIdentityDeps,
  type RecordSet,
} from "@obsidion/front-core"
import { AUTH_TYPE, type AlphaAuthProvider } from "@obsidion/sdk"
import { predictAccountAddressLocally } from "@oxide/l1-contracts"
import { getContractAddress, type Address } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { later } from "../../../front-core/test/engine/taskTable"
import {
  catchUpMovedAccount,
  movedAccountCatchUp,
  type CatchUpDeps,
} from "../../src/app/movedAccountCatchUp"
import { isGateCancelled } from "../../src/features/identity/ceremonyGate"
import { isCommittedFailure } from "../../src/features/identity/passkeyAccount"
import { SessionChangedError } from "../../src/platform/auth/sessionErrors"
import type { OnboardingKeys } from "../../src/session/account"
import { giveAccountRecord } from "../support/accountRecord"
import { signedRecord, storedRotation } from "../support/backupAdd"
import { setIdentity } from "../support/identity"
import { seedDeviceKeys } from "../support/page"
import { openTestSession } from "../support/session"

const h = {
  unlocked: undefined as unknown,
  record: undefined as unknown,
  held: true,
  /** What the tag's user record names on the chain, and a hook on reading it. */
  chainRecord: "" as string,
  onRecordRead: undefined as (() => Promise<void>) | undefined,
  generations: vi.fn(),
  authKeys: vi.fn(),
  commitSecret: vi.fn(),
  recordRecoveryMetadata: vi.fn(),
  markRecordsStale: vi.fn(),
  saveIdentity: vi.fn(),
  reload: vi.fn(),
  /** A signer over a key set: the fake wallet reads the set back off it. */
  providerFor: vi.fn((passkey: { passkeys: readonly string[] }) => ({
    getPubkeys: async () => [Buffer.alloc(32, 1), Buffer.alloc(32, 2)],
    passkeys: passkey.passkeys,
  })),
}

const msk = Fr.random()
const OLD = `0x${"aa".repeat(32)}`
const NEW = `0x${"bb".repeat(32)}`
const ROOT = "ab".repeat(64)
const BACKUP = "ef".repeat(64)
const FACTORY = `0x${"11".repeat(20)}` as Address
const REGISTRY = `0x${"22".repeat(20)}` as Address
const METADATA = `0x${"23".repeat(20)}` as Address
/** The L1 account the deployment's factory predicts for the session's key. */
const ACCOUNT = predictAccountAddressLocally(FACTORY, deriveBootstrapKey(msk).address)
const NAME = `0x${"5a".repeat(32)}`
const MARK = "zkm.once.movedAccount"

/**
 * The deployment as the catch-up loads it: one generation on the current rollup, over a chain where
 * `ACCOUNT` holds the tag and its user record names `h.chainRecord`. Resolving that address verifies
 * it; resolving another finds the account unverified.
 */
const generations = (): OxideIdentityDeps => ({
  reader: {
    readNameOf: async (_registry: Address, account: Address) =>
      account.toLowerCase() === ACCOUNT.toLowerCase() ? NAME : `0x${"0".repeat(64)}`,
    readAccountMetadataRegistry: async () => METADATA,
    readUserRecord: async () => {
      await h.onRecordRead?.()
      return { l2Address: h.chainRecord, rollupVersion: 1n }
    },
    readNamePortalRegistry: async () => REGISTRY,
    readFactoryImplementation: async (factory: Address) =>
      getContractAddress({ from: factory, nonce: 1n }),
  } as unknown as OxideIdentityDeps["reader"],
  registry: REGISTRY,
  rollupVersion: "1",
  catalog: [
    {
      fpcAddress: `0x${"0b".repeat(32)}`,
      accountFactory: FACTORY,
      namePortal: `0x${"24".repeat(20)}` as Address,
      rollupVersion: "1",
    },
  ],
})

const deps: CatchUpDeps = {
  sessionKeys: async () => h.unlocked as OnboardingKeys | undefined,
  generations: h.generations,
  readAuthKeys: (_page, account) => h.authKeys(account),
  saveIdentity: h.saveIdentity,
  reload: h.reload,
}

const accountAt = (address: string) => ({
  getAddress: () => ({ toString: () => address }),
  getCompleteAddress: () => ({ toString: () => `${address}:complete` }),
})
/** The address exists under the session's key and a set holding its signing key: two keys derive the new one. */
const wallet = {
  deriveAccountAddress: async (candidate: Fr, passkeys: readonly string[]) => ({
    toString: () =>
      candidate.toString() !== msk.toString() || !passkeys.includes(ROOT)
        ? "0xother"
        : passkeys.includes(BACKUP)
        ? NEW
        : OLD,
  }),
  createObsidionAccount: async (_msk: Fr, provider: { passkeys?: readonly string[] }) =>
    provider.passkeys?.includes(BACKUP) ? accountAt(NEW) : accountAt(OLD),
} as never
const listing = (keys: string[], authKeyCount = keys.length) => ({
  entries: keys.map((key) => ({
    key: { qx: `0x${key.slice(0, 64)}`, qy: `0x${key.slice(64)}` },
    metadata: "0x",
  })),
  authKeyCount,
})
const sessionKeys = () => ({
  account: accountAt(OLD),
  secretKey: msk,
  authProvider: {} as AlphaAuthProvider,
  pubkeyHex: `0x${ROOT}`,
})
const oldRecord = () => ({
  credentialId: "cred",
  l2Address: OLD,
  pubkey: ROOT,
  prfSlot: "first" as const,
  isMskRoot: true,
  transports: ["internal"],
})
const SIGNER = { credentialId: "cred", pubkey: ROOT, authenticatorType: "platform" as const }
/** The browser's stored account at `address`, signed by the session's passkey. */
const storedAccount = (address: string) => ({
  completeAddress: `${address}:complete`,
  signKeyConfig: { type: AUTH_TYPE.WEB_AUTHN, webauthnData: SIGNER },
})
/** The save that stored the account at `address`. */
const accountSaved = (address: string) =>
  ({ type: "saved", completeAddress: `${address}:complete`, signer: SIGNER } as const)
/** A backup add on this device, signed but not yet switched, over the session's account. */
const pendingReroot = () =>
  signedRecord({
    rotation: storedRotation({
      builtOver: { ...storedRotation().builtOver, l2Address: OLD as `0x${string}` },
    }),
  })

const fakeAuth = () => ({
  rpId: "localhost",
  accountRecord: async (address: string) =>
    (h.record as { l2Address?: string } | undefined)?.l2Address === address ? h.record : undefined,
  providerFor: h.providerFor,
  commitSecret: h.commitSecret,
  sessionHeld: () => h.held,
  sessionAddress: async () => (h.record as { l2Address?: string } | undefined)?.l2Address,
  markRecordsStale: h.markRecordsStale,
  recordRecoveryMetadata: h.recordRecoveryMetadata,
  recordsStale: () => true,
})

type Rotations = readonly BackupRotationRecord[] | "loading" | "unreadable"
const rotationsOf = (state: Rotations) =>
  memoryStore<RecordSet<BackupRotationRecord>>(
    state === "loading"
      ? { records: [], loaded: false, failed: false }
      : state === "unreadable"
      ? { records: [], loaded: true, failed: true }
      : { records: state, loaded: true, failed: false },
  )

let stash: Map<string, string>
let rotations: ReturnType<typeof rotationsOf>
let session: ReturnType<typeof openTestSession>
let snapshot: Awaited<ReturnType<typeof giveAccountRecord>>

async function open(state: Rotations = []) {
  rotations = rotationsOf(state)
  session = openTestSession({
    auth: fakeAuth(),
    backupRotations: { view: rotations.readonly },
  })
  snapshot = await giveAccountRecord(accountSaved(OLD), session)
  await setIdentity({ address: OLD, handle: "alice" })
}

const run = (signal = new AbortController().signal) =>
  catchUpMovedAccount(session, wallet, {} as never, signal, deps)

/** The session on the two-key account with its record rewritten under it. */
const switchedToNew = () => {
  h.unlocked = { ...sessionKeys(), account: accountAt(NEW) }
  h.record = { ...oldRecord(), l2Address: NEW, passkeySet: [ROOT, BACKUP] }
}

/** Another account's sign-in committed on this page: the device points at its namespace. */
const anotherAccountCommitted = () => seedDeviceKeys({ storageId: "other", credentialId: "cred" })

beforeEach(async () => {
  vi.clearAllMocks()
  stash = new Map()
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => stash.get(key) ?? null,
    setItem: (key: string, value: string) => void stash.set(key, value),
    removeItem: (key: string) => void stash.delete(key),
  })
  h.unlocked = sessionKeys()
  h.record = oldRecord()
  h.held = true
  h.commitSecret.mockImplementation(async (_input: unknown, stillOwns: () => boolean) =>
    stillOwns() ? 1 : false,
  )
  // The tag's record names the two-key address: the old one is unverified, the new one verified.
  h.chainRecord = NEW
  h.onRecordRead = undefined
  h.generations.mockImplementation(async () => generations())
  h.authKeys.mockResolvedValue(listing([ROOT, BACKUP]))
  await seedDeviceKeys({ storageId: "acct", credentialId: "cred" })
  await open()
})

afterEach(() => vi.unstubAllGlobals())

const nothingWritten = async () => {
  expect(h.commitSecret).not.toHaveBeenCalled()
  expect(h.recordRecoveryMetadata).not.toHaveBeenCalled()
  expect(await snapshot.get()).toEqual(storedAccount(OLD))
  expect(h.saveIdentity).not.toHaveBeenCalled()
  expect(h.reload).not.toHaveBeenCalled()
  expect(stash.get(MARK)).toBeUndefined()
}

const nothingRead = () => {
  expect(h.generations).not.toHaveBeenCalled()
  expect(h.authKeys).not.toHaveBeenCalled()
}

describe("catchUpMovedAccount", () => {
  it("adopts the two-key account: commit, then the record and snapshot under it, the identity moved, the page reloaded", async () => {
    await run()
    expect(h.providerFor).toHaveBeenCalledWith({
      credentialId: "cred",
      pubkeyHex: ROOT,
      passkeys: [ROOT, BACKUP],
    })
    expect(h.commitSecret).toHaveBeenCalledWith(
      { secretKey: msk, authProvider: h.providerFor.mock.results[0]!.value },
      expect.any(Function),
    )
    expect(h.commitSecret.mock.invocationCallOrder[0]).toBeLessThan(
      h.recordRecoveryMetadata.mock.invocationCallOrder[0]!,
    )
    expect(h.recordRecoveryMetadata).toHaveBeenCalledWith(
      {
        credentialId: "cred",
        l2Address: NEW,
        pubkey: ROOT,
        prfSlot: "first",
        isMskRoot: true,
        passkeySet: [ROOT, BACKUP],
        authenticatorType: "platform",
        transports: ["internal"],
      },
      expect.any(Function),
    )
    expect(h.markRecordsStale).toHaveBeenCalled()
    expect(await snapshot.get()).toEqual(storedAccount(NEW))
    expect(h.saveIdentity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ address: NEW, handle: "alice" }),
      expect.any(Function),
    )
    expect(stash.get(MARK)).toBe(NEW)
    expect(h.reload).toHaveBeenCalledWith(expect.anything(), NEW)
  })

  it("an identity write that failed is finished by a later run, with no second commit", async () => {
    h.saveIdentity.mockRejectedValueOnce(new Error("disk full"))
    await expect(run()).rejects.toSatisfy(isCommittedFailure)
    expect(await snapshot.get()).toEqual(storedAccount(NEW))
    expect(stash.get(MARK)).toBeUndefined()
    expect(h.reload).not.toHaveBeenCalled()
    // The next run finds the session on the two-key account, its record rewritten, and the
    // identity row still naming the one before.
    switchedToNew()
    await run()
    expect(h.commitSecret).toHaveBeenCalledTimes(1)
    expect(h.authKeys).toHaveBeenCalledTimes(1)
    expect(h.recordRecoveryMetadata).toHaveBeenCalledTimes(1)
    expect(await snapshot.get()).toEqual(storedAccount(NEW))
    expect(h.saveIdentity).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ address: NEW, handle: "alice" }),
      expect.any(Function),
    )
    expect(stash.get(MARK)).toBeUndefined()
    expect(h.reload).toHaveBeenCalledWith(expect.anything(), NEW)
  })

  it("a snapshot write that failed is finished by a later run, with no second commit", async () => {
    vi.spyOn(snapshot, "apply").mockRejectedValueOnce(new Error("disk full"))
    await expect(run()).rejects.toSatisfy(isCommittedFailure)
    expect(h.recordRecoveryMetadata).toHaveBeenCalledTimes(1)
    expect(await snapshot.get()).toEqual(storedAccount(OLD))
    expect(h.saveIdentity).not.toHaveBeenCalled()
    expect(h.reload).not.toHaveBeenCalled()
    // The next run finds the session on the two-key account, its record rewritten, and the
    // snapshot and the identity row still naming the one before.
    switchedToNew()
    await run()
    expect(h.commitSecret).toHaveBeenCalledTimes(1)
    expect(h.authKeys).toHaveBeenCalledTimes(1)
    expect(h.recordRecoveryMetadata).toHaveBeenCalledTimes(1)
    expect(await snapshot.get()).toEqual(storedAccount(NEW))
    expect(h.saveIdentity).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ address: NEW, handle: "alice" }),
      expect.any(Function),
    )
    expect(stash.get(MARK)).toBeUndefined()
    expect(h.reload).toHaveBeenCalledWith(expect.anything(), NEW)
  })

  it("a record write that failed is finished by a later run, with no second commit", async () => {
    h.recordRecoveryMetadata.mockRejectedValueOnce(new Error("disk full"))
    await expect(run()).rejects.toSatisfy(isCommittedFailure)
    expect(await snapshot.get()).toEqual(storedAccount(OLD))
    expect(h.saveIdentity).not.toHaveBeenCalled()
    expect(h.reload).not.toHaveBeenCalled()
    // The next run finds the session on the two-key account and its record, snapshot and identity
    // row still naming the one before.
    h.unlocked = { ...sessionKeys(), account: accountAt(NEW) }
    await run()
    expect(h.commitSecret).toHaveBeenCalledTimes(1)
    expect(h.recordRecoveryMetadata).toHaveBeenCalledTimes(2)
    expect(h.recordRecoveryMetadata).toHaveBeenLastCalledWith(
      {
        credentialId: "cred",
        l2Address: NEW,
        pubkey: ROOT,
        prfSlot: "first",
        isMskRoot: true,
        passkeySet: [ROOT, BACKUP],
        authenticatorType: "platform",
        transports: ["internal"],
      },
      expect.any(Function),
    )
    expect(await snapshot.get()).toEqual(storedAccount(NEW))
    expect(h.saveIdentity).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ address: NEW, handle: "alice" }),
      expect.any(Function),
    )
    expect(stash.get(MARK)).toBe(NEW)
    expect(h.reload).toHaveBeenCalledWith(expect.anything(), NEW)
  })

  it("an identity verified for the session's address reads no keys and writes nothing", async () => {
    h.chainRecord = OLD
    await run()
    expect(h.authKeys).not.toHaveBeenCalled()
    await nothingWritten()
  })

  it.each([
    ["one key", listing([ROOT])],
    ["three keys", listing([ROOT, BACKUP, "cd".repeat(64)])],
    ["two keys without the session's", listing(["cd".repeat(64), BACKUP])],
  ])("a list of %s is no move", async (_shape, list) => {
    h.authKeys.mockResolvedValue(list)
    await run()
    await nothingWritten()
  })

  it("waits for the rotation records to read: the run fails and backs off", async () => {
    await open("loading")
    await expect(run()).rejects.toMatchObject({ code: "wallet.notReady" })
    nothingRead()
  })

  it("unreadable rotation records end the run with nothing read", async () => {
    await open("unreadable")
    await run()
    nothingRead()
    await nothingWritten()
  })

  it("a backup add on this device ahead of its switch leaves the account to it", async () => {
    await open([pendingReroot()])
    await run()
    nothingRead()
    await nothingWritten()
  })

  it("a backup add saved during the key read ends the attempt before the commit", async () => {
    h.authKeys.mockImplementation(async () => {
      rotations.set({ records: [pendingReroot()], loaded: true, failed: false })
      return listing([ROOT, BACKUP])
    })
    await expect(run()).rejects.toSatisfy(isGateCancelled)
    await nothingWritten()
  })

  it("a record opened by another credential than the session's is left alone", async () => {
    h.record = { ...oldRecord(), credentialId: "other" }
    await run()
    nothingRead()
    await nothingWritten()
  })

  it("a record without a PRF slot is left alone", async () => {
    h.record = { ...oldRecord(), prfSlot: undefined }
    await run()
    nothingRead()
    await nothingWritten()
  })

  it("a locked wallet reads nothing", async () => {
    h.unlocked = undefined
    await run()
    nothingRead()
    await nothingWritten()
  })

  it("a failed key read fails the run, with nothing written", async () => {
    const failure = new Error("rpc down")
    h.authKeys.mockRejectedValue(failure)
    await expect(run()).rejects.toBe(failure)
    await nothingWritten()
  })

  it("the run's abort during the reads ends in the cancel, with nothing written", async () => {
    const controller = new AbortController()
    h.authKeys.mockImplementation(async () => {
      controller.abort()
      return listing([ROOT, BACKUP])
    })
    await expect(run(controller.signal)).rejects.toSatisfy(isGateCancelled)
    await nothingWritten()
  })

  it("a newer commit before the record write ends the run as committed, with no snapshot, mark or reload", async () => {
    h.held = false
    await expect(run()).rejects.toSatisfy(isCommittedFailure)
    expect(h.commitSecret).toHaveBeenCalled()
    expect(h.recordRecoveryMetadata).not.toHaveBeenCalled()
    expect(await snapshot.get()).toEqual(storedAccount(OLD))
    expect(h.saveIdentity).not.toHaveBeenCalled()
    expect(stash.get(MARK)).toBeUndefined()
    expect(h.reload).not.toHaveBeenCalled()
  })

  it("a newer commit once the snapshot is saved gets no identity, mark or reload from this run", async () => {
    const lock = session.sessionLock
    // The session changes hands at the first lock taken after the snapshot landed.
    Object.defineProperty(session, "sessionLock", {
      configurable: true,
      value: (work: () => Promise<unknown>) =>
        lock(async () => {
          if ((await snapshot.get())?.completeAddress === `${NEW}:complete`) h.held = false
          return work()
        }),
    })
    try {
      await expect(run()).rejects.toSatisfy(isCommittedFailure)
    } finally {
      Object.defineProperty(session, "sessionLock", { configurable: true, value: lock })
    }
    expect(await snapshot.get()).toEqual(storedAccount(NEW))
    expect(h.saveIdentity).not.toHaveBeenCalled()
    expect(stash.get(MARK)).toBeUndefined()
    expect(h.reload).not.toHaveBeenCalled()
  })

  it("a newer commit during the identity write ends the run with no mark or reload", async () => {
    h.saveIdentity.mockImplementationOnce(async () => void (h.held = false))
    await expect(run()).rejects.toSatisfy(isCommittedFailure)
    expect(h.saveIdentity).toHaveBeenCalledTimes(1)
    expect(stash.get(MARK)).toBeUndefined()
    expect(h.reload).not.toHaveBeenCalled()
  })

  it("a session another account's sign-in replaced reads nothing", async () => {
    await anotherAccountCommitted()
    await run()
    nothingRead()
    await nothingWritten()
  })

  it("another account committed during the key read ends the attempt before the commit", async () => {
    h.authKeys.mockImplementation(async () => {
      await anotherAccountCommitted()
      return listing([ROOT, BACKUP])
    })
    await expect(run()).rejects.toSatisfy(isGateCancelled)
    await nothingWritten()
  })

  it("another account committed during the identity read gets no identity from the finish", async () => {
    switchedToNew()
    h.onRecordRead = anotherAccountCommitted
    await expect(run()).rejects.toBeInstanceOf(SessionChangedError)
    expect(h.saveIdentity).not.toHaveBeenCalled()
    expect(h.reload).not.toHaveBeenCalled()
  })
})

describe("movedAccountCatchUp", () => {
  it("runs once the wallet, the account and the contracts are ready", async () => {
    const needs = {
      wallet: later("wallet"),
      account: later("account"),
      contractService: later("cs"),
    }
    const reloaded = new Promise<void>((resolve) => h.reload.mockImplementation(() => resolve()))
    const runtime = startRuntime(
      [
        movedAccountCatchUp(
          {
            session,
            wallet: needs.wallet.service as never,
            account: needs.account.service as never,
            contractService: needs.contractService.service as never,
          },
          deps,
        ),
      ],
      {
        db: openDatabase(memoryBackend()),
        milestones: { after: async () => true, reached: () => false },
        visible: memoryStore(true).readonly,
        pace: createPace(),
        now: () => Date.now(),
      },
    )
    try {
      needs.wallet.ready(wallet)
      needs.account.ready(accountAt(OLD))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(h.generations).not.toHaveBeenCalled()
      needs.contractService.ready({})
      await reloaded
      expect(stash.get(MARK)).toBe(NEW)
    } finally {
      runtime.stop()
    }
  })
})
