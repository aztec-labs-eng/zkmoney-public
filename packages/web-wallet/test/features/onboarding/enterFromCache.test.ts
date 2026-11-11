// @vitest-environment node
/**
 * `/enter` over the session's own key: no ceremony, the record anchors, and the Registry decides
 * between a named account and a nameless one.
 */
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { RecoverPasskeyResult } from "@obsidion/sdk"
import { predictAccountAddressLocally } from "@oxide/l1-contracts"
import { getContractAddress, type Address } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeReads } from "../../support/fakeReads"
import { openTestSession } from "../../support/session"
import { testCore } from "../../support/page"
import { recordingAccounts } from "../../support/accountRecord"

const h = vi.hoisted(() => ({
  adoptAccountPasskey: vi.fn(),
  beginRecovery: vi.fn(),
  recoverFromCache: vi.fn(),
  commitSecret: vi.fn(async (): Promise<number | false> => 1),
  recordRecoveryMetadata: vi.fn(),
  rootCredentialId: vi.fn(),
  addWebauthnAccount: vi.fn(),
  readNameOf: vi.fn(),
  previousName: vi.fn(),
  recordedL2: vi.fn(),
  authKeys: vi.fn(),
  markRecordsStale: vi.fn(),
  /** A signer over a key set: the fake wallet reads the set back off it. */
  providerFor: vi.fn((passkey: { passkeys: readonly string[] }) => ({
    getPubkeys: async () => [Buffer.alloc(32, 1), Buffer.alloc(32, 2)],
    passkeys: passkey.passkeys,
  })),
}))

const fakeAuth = () => ({
  rpId: "localhost",
  device: testCore().device,
  adoptAccountPasskey: h.adoptAccountPasskey,
  beginRecovery: h.beginRecovery,
  recoverFromCache: h.recoverFromCache,
  commitSecret: h.commitSecret,
  sessionHeld: () => true,
  sessionAddress: async () => undefined,
  markRecordsStale: h.markRecordsStale,
  providerFor: h.providerFor,
  recordRecoveryMetadata: h.recordRecoveryMetadata,
  rootCredentialId: h.rootCredentialId,
  answeredLocally: () => false,
  // A held key answered no route, so a record mismatch is never the certain wrong key.
  mismatchVerdict: () => "not-reproduced",
})
vi.mock("../../../src/config/oxideTuple", () => ({
  requireTupleField: (tuple: Record<string, string>, key: string) => tuple[key],
  l1PublicClient: () => ({}),
}))
const { deriveBootstrapKey } = await import("@obsidion/front-core")
const msk = Fr.random()
const ACTIVE_FACTORY = `0x${"11".repeat(20)}` as const
const PREVIOUS_FACTORY = `0x${"19".repeat(20)}` as const
const REGISTRY = `0x${"22".repeat(20)}`
const METADATA = `0x${"23".repeat(20)}`
/** The account the resolver predicts for the held key under `factory`. */
const accountUnder = (factory: Address) =>
  predictAccountAddressLocally(factory, deriveBootstrapKey(msk).address)
const ACTIVE_ACCOUNT = accountUnder(ACTIVE_FACTORY)
const generation = (fpcAddress: string, accountFactory: string) => ({
  fpcAddress,
  accountFactory,
  namePortal: `${accountFactory.slice(0, 40)}ee`,
  rollupVersion: "1",
})
const CATALOG = [
  generation(`0x${"0b".repeat(32)}`, ACTIVE_FACTORY),
  generation(`0x${"0a".repeat(32)}`, PREVIOUS_FACTORY),
]
/** The chain the identity resolver really reads: both factories, one registry, one record. */
const reader = {
  readNameOf: async (_registry: string, account: string) =>
    account === ACTIVE_ACCOUNT ? await h.readNameOf() : await h.previousName(),
  readAccountMetadataRegistry: async () => METADATA,
  readUserRecord: async () => ({ l2Address: h.recordedL2(), rollupVersion: 1n }),
  readNamePortalRegistry: async () => REGISTRY,
  readFactoryImplementation: async (factory: string) =>
    getContractAddress({ from: factory as Address, nonce: 1n }),
  readAuthKeysCounted: async (account: string) => h.authKeys(account),
}
const published = { catalog: CATALOG as unknown[] }
vi.mock("../../../src/features/registration/oxideGenerations", () => ({
  loadOxideGenerations: async () => ({
    reader,
    registry: REGISTRY,
    rollupVersion: "1",
    catalog: published.catalog,
  }),
  generationFactories: () => [ACTIVE_FACTORY, PREVIOUS_FACTORY],
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  createOxideL1Reader: () => reader,
}))

const { enterWithPasskey } = await import("../../../src/features/onboarding/oxideOnboarding")
const { reusePasskeyAccount } = await import("../../../src/features/identity/passkeyAccount")
const { isGateCancelled } = await import("../../../src/features/identity/ceremonyGate")

const ADDR = `0x${"aa".repeat(32)}`
/** The two-key account a backup add on another browser moved the wallet to. */
const NEW = `0x${"bb".repeat(32)}`
const PUBKEY = "ab".repeat(64)
const BACKUP = "ef".repeat(64)
const accountAt = (address: string) => ({
  getAddress: () => ({ toString: () => address }),
  getCompleteAddress: () => ({ toString: () => `${address}:complete` }),
})
const account = accountAt(ADDR)
/**
 * The address exists only under the held key's master key AND a set holding its signing key; the
 * set with the backup key beside it derives the two-key account.
 */
const deriveAccountAddress = vi.fn(async (candidate: Fr, passkeys: readonly string[]) => ({
  toString: () =>
    candidate.toString() !== msk.toString() || !passkeys.includes(PUBKEY)
      ? "0xother"
      : passkeys.includes(BACKUP)
      ? NEW
      : ADDR,
}))
const wallet = {
  deriveAccountAddress,
  createObsidionAccount: async (_msk: Fr, provider: { passkeys?: readonly string[] }) =>
    provider.passkeys?.includes(BACKUP) ? accountAt(NEW) : account,
} as never
/** An account's installed keys as the chain lists them, with its total count. */
const listing = (keys: string[], authKeyCount = keys.length) => ({
  entries: keys.map((key) => ({
    key: { qx: `0x${key.slice(0, 64)}`, qy: `0x${key.slice(64)}` },
    metadata: "0x",
  })),
  authKeyCount,
})
const oxideTuple = async () => ({
  accountFactory: `0x${"11".repeat(20)}`,
  registry: `0x${"22".repeat(20)}`,
  ensDomain: "zkmoney.eth",
})
const page = { config: { rpId: "localhost" }, chain: fakeReads({ oxideTuple }) } as never
const gate = vi.fn(async () => ({
  signal: new AbortController().signal,
  reach: "unknown" as const,
}))

const held: RecoverPasskeyResult = {
  authProvider: { getPubkeys: async () => [Buffer.alloc(32, 1), Buffer.alloc(32, 2)] } as never,
  credentialId: "cred",
  pubkey: PUBKEY,
  candidates: { first: msk },
  preferredSlot: "first",
  hasPersistedSlot: false,
  candidateSource: "webauthn",
  expectedAddress: ADDR,
  authenticatorType: "platform",
}

const accounts = recordingAccounts((state) => h.addWebauthnAccount(state))
/** What a sign-in reads beside its request: the account records and the session it starts in. */
const signInDeps = {
  accounts,
  get session() {
    return openTestSession()
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  h.recoverFromCache.mockResolvedValue(held)
  h.recordedL2.mockReturnValue(ADDR)
  h.authKeys.mockResolvedValue(listing([PUBKEY]))
  h.previousName.mockResolvedValue(`0x${"0".repeat(64)}`)
  published.catalog = CATALOG
})

afterEach(() => vi.unstubAllGlobals())

beforeEach(() => void openTestSession({ auth: fakeAuth() }))

describe("enterWithPasskey from the session's key", () => {
  it("a zero Registry record is a nameless account, adopted with no ceremony and no gate", async () => {
    h.readNameOf.mockResolvedValue(`0x${"0".repeat(64)}`)
    const result = await enterWithPasskey(wallet, page, undefined, {
      signIn: signInDeps,
      contractService: {} as never,
      gate,
      tiers: [],
    })
    expect(result).toMatchObject({ entered: false, reason: "unclaimed", account })
    expect(gate).not.toHaveBeenCalled()
    expect(h.adoptAccountPasskey).not.toHaveBeenCalled()
    expect(h.beginRecovery).not.toHaveBeenCalled()
    expect(h.commitSecret).toHaveBeenCalledWith(
      expect.objectContaining({ secretKey: msk, authProvider: held.authProvider }),
      expect.any(Function),
    )
    expect(h.addWebauthnAccount).toHaveBeenCalledTimes(1)
    // The record's address is checked under the record's own signing key.
    expect(deriveAccountAddress).toHaveBeenCalledWith(msk, [PUBKEY])
    expect(h.recordRecoveryMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        l2Address: ADDR,
        pubkey: PUBKEY,
        passkeySet: [PUBKEY],
        isMskRoot: true,
      }),
      expect.any(Function),
    )
  })

  it("a held backup key enters under its set and is recorded as a backup with its envelope", async () => {
    const passkeys = ["cd".repeat(64), PUBKEY]
    const backup = { account: `0x${"11".repeat(20)}`, envelope: `01${"00".repeat(61)}` }
    h.recoverFromCache.mockResolvedValue({ ...held, passkeys, backup })
    h.readNameOf.mockResolvedValue(`0x${"0".repeat(64)}`)
    const result = await enterWithPasskey(wallet, page, undefined, {
      signIn: signInDeps,
      contractService: {} as never,
      gate,
      tiers: [],
    })
    expect(result).toMatchObject({ entered: false, reason: "unclaimed", account })
    expect(deriveAccountAddress).toHaveBeenCalledWith(msk, passkeys)
    expect(h.recordRecoveryMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ l2Address: ADDR, passkeySet: passkeys, isMskRoot: false, backup }),
      expect.any(Function),
    )
  })

  it("a ceremony's reuse runs under the caller's cancel past the prompt: closed, nothing is written", async () => {
    // No held key, so the gate opens and a ceremony answers; the gate's own attempt stays live, and
    // only the caller's signal is aborted — during the address check, after the prompt.
    h.recoverFromCache.mockResolvedValue(undefined)
    h.beginRecovery.mockResolvedValue(held)
    const op = new AbortController()
    deriveAccountAddress.mockImplementationOnce(async () => {
      op.abort()
      return { toString: () => ADDR }
    })
    await expect(
      reusePasskeyAccount(wallet, signInDeps, ADDR, undefined, gate, op.signal),
    ).rejects.toSatisfy(isGateCancelled)
    expect(gate).toHaveBeenCalledTimes(1)
    expect(h.recordRecoveryMetadata).not.toHaveBeenCalled()
    expect(h.commitSecret).not.toHaveBeenCalled()
    expect(h.addWebauthnAccount).not.toHaveBeenCalled()
  })

  it("a held key reused for a known account runs under the caller's cancel: closed, nothing is written", async () => {
    const op = new AbortController()
    deriveAccountAddress.mockImplementationOnce(async () => {
      op.abort()
      return { toString: () => ADDR }
    })
    await expect(
      reusePasskeyAccount(wallet, signInDeps, ADDR, undefined, gate, op.signal),
    ).rejects.toSatisfy(isGateCancelled)
    expect(gate).not.toHaveBeenCalled()
    expect(h.recordRecoveryMetadata).not.toHaveBeenCalled()
    expect(h.commitSecret).not.toHaveBeenCalled()
    expect(h.addWebauthnAccount).not.toHaveBeenCalled()
  })

  it("a held key recorded under another signing key derives no matching address: refused", async () => {
    h.recoverFromCache.mockResolvedValue({ ...held, pubkey: "cd".repeat(64) })
    h.readNameOf.mockResolvedValue(`0x${"0".repeat(64)}`)
    await expect(
      enterWithPasskey(wallet, page, undefined, {
        signIn: signInDeps,
        contractService: {} as never,
        gate,
        tiers: [],
      }),
    ).rejects.toThrow(/does not match/)
    expect(deriveAccountAddress).toHaveBeenCalledWith(msk, ["cd".repeat(64)])
    expect(h.commitSecret).not.toHaveBeenCalled()
    expect(h.addWebauthnAccount).not.toHaveBeenCalled()
  })

  it("the chooser ignores the held key and runs the ceremony behind the gate", async () => {
    h.beginRecovery.mockResolvedValue(held)
    h.readNameOf.mockResolvedValue(`0x${"0".repeat(64)}`)
    await enterWithPasskey(wallet, page, undefined, {
      signIn: signInDeps,
      contractService: {} as never,
      gate,
      tiers: [],
      chooser: true,
    })
    expect(gate).toHaveBeenCalledTimes(1)
    expect(h.beginRecovery).toHaveBeenCalledWith(expect.objectContaining({ discover: true }))
    expect(h.recoverFromCache).not.toHaveBeenCalled()
  })

  it("a laptop enter on a browser with a record still stays discoverable", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" })
    h.recoverFromCache.mockResolvedValue(undefined)
    h.rootCredentialId.mockResolvedValue("root-a")
    h.beginRecovery.mockResolvedValue(held)
    h.readNameOf.mockResolvedValue(`0x${"0".repeat(64)}`)
    await enterWithPasskey(wallet, page, undefined, {
      signIn: signInDeps,
      contractService: {} as never,
      gate,
      tiers: [],
    })
    // The record is never pinned from the screen: the browser's own chooser lists whatever holds
    // the passkey, and the anchors decide.
    expect(h.beginRecovery).toHaveBeenCalledWith(expect.objectContaining({ discover: true }))
    expect(h.beginRecovery).not.toHaveBeenCalledWith(
      expect.objectContaining({ credentialId: "root-a" }),
    )
  })

  it("a phone plain enter keeps the pin when the cache is empty", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4) Mobile" })
    h.recoverFromCache.mockResolvedValue(undefined)
    h.beginRecovery.mockResolvedValue(held)
    h.readNameOf.mockResolvedValue(`0x${"0".repeat(64)}`)
    await enterWithPasskey(wallet, page, undefined, {
      signIn: signInDeps,
      contractService: {} as never,
      gate,
      tiers: [],
    })
    expect(h.beginRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ credentialId: undefined }),
    )
  })
})

describe("enterWithPasskey as the arrival probe", () => {
  const LAPTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
  const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4) Mobile"
  const nameless = `0x${"0".repeat(64)}`

  // A once-queued answer left by an earlier test must not leak into the next.
  beforeEach(() => h.recoverFromCache.mockReset().mockResolvedValue(held))

  it.each([
    ["laptop", LAPTOP],
    ["phone", PHONE],
  ])(
    "with no held key on a %s it reports ceremony-required before any gate or prompt",
    async (_p, ua) => {
      vi.stubGlobal("navigator", { userAgent: ua })
      h.recoverFromCache.mockResolvedValue(undefined)
      const result = await enterWithPasskey(wallet, page, undefined, {
        signIn: signInDeps,
        contractService: {} as never,
        gate,
        tiers: [],
        cacheOnly: true,
      })
      expect(result).toEqual({ entered: false, reason: "ceremony-required" })
      expect(gate).not.toHaveBeenCalled()
      expect(h.beginRecovery).not.toHaveBeenCalled()
      expect(h.adoptAccountPasskey).not.toHaveBeenCalled()
      expect(h.commitSecret).not.toHaveBeenCalled()
    },
  )

  it("the key source is resolved once: a source that answers first and not again still never reaches the gate", async () => {
    vi.stubGlobal("navigator", { userAgent: LAPTOP })
    h.recoverFromCache.mockResolvedValueOnce(held).mockResolvedValueOnce(undefined)
    h.readNameOf.mockResolvedValue(nameless)
    const result = await enterWithPasskey(wallet, page, undefined, {
      signIn: signInDeps,
      contractService: {} as never,
      gate,
      tiers: [],
      cacheOnly: true,
    })
    expect(result).toMatchObject({ entered: false, reason: "unclaimed" })
    expect(h.recoverFromCache).toHaveBeenCalledTimes(1)
    expect(gate).not.toHaveBeenCalled()
    expect(h.beginRecovery).not.toHaveBeenCalled()
  })

  it("restoreCache:false asks the cache for the key in memory only; a miss runs the ceremony", async () => {
    vi.stubGlobal("navigator", { userAgent: LAPTOP })
    h.readNameOf.mockResolvedValue(nameless)
    await enterWithPasskey(wallet, page, undefined, {
      signIn: signInDeps,
      contractService: {} as never,
      gate,
      tiers: [],
      restoreCache: false,
    })
    expect(h.recoverFromCache).toHaveBeenCalledWith({ restore: false })
    expect(gate).not.toHaveBeenCalled()

    vi.clearAllMocks()
    h.recoverFromCache.mockResolvedValue(undefined)
    h.beginRecovery.mockResolvedValue(held)
    h.readNameOf.mockResolvedValue(nameless)
    await enterWithPasskey(wallet, page, undefined, {
      signIn: signInDeps,
      contractService: {} as never,
      gate,
      tiers: [],
      restoreCache: false,
    })
    expect(h.recoverFromCache).toHaveBeenCalledWith({ restore: false })
    expect(gate).toHaveBeenCalledTimes(1)
    expect(h.beginRecovery).toHaveBeenCalledTimes(1)
  })

  it("a failure before the commit is untagged; one after it carries the commit", async () => {
    h.readNameOf.mockRejectedValueOnce(new Error("rpc down"))
    await expect(
      enterWithPasskey(wallet, page, undefined, {
        signIn: signInDeps,
        contractService: {} as never,
        gate,
        tiers: [],
        cacheOnly: true,
      }),
    ).rejects.not.toHaveProperty("committed")
    expect(h.commitSecret).not.toHaveBeenCalled()

    h.readNameOf.mockResolvedValue(nameless)
    h.addWebauthnAccount.mockRejectedValueOnce(new Error("disk full"))
    await expect(
      enterWithPasskey(wallet, page, undefined, {
        signIn: signInDeps,
        contractService: {} as never,
        gate,
        tiers: [],
        cacheOnly: true,
      }),
    ).rejects.toMatchObject({ message: "disk full", committed: true })
    expect(h.commitSecret).toHaveBeenCalledTimes(1)
  })
})

describe("an account the previous factory holds, after the factory roll", () => {
  /** The roll moves the address a key predicts, so the active factory holds nothing for this user. */
  const rolledOver = async () => {
    const { composeWireNameHash } = await import("@obsidion/front-core")
    h.readNameOf.mockResolvedValue(`0x${"0".repeat(64)}`)
    h.previousName.mockResolvedValue(composeWireNameHash("alice", "zkmoney.eth"))
  }

  it("the stored session enters the account the previous factory holds, not a new signup", async () => {
    await rolledOver()

    const result = await enterWithPasskey(wallet, page, "alice", {
      signIn: signInDeps,
      contractService: {} as never,
      gate,
      tiers: [],
    })

    expect(result).toMatchObject({ entered: true, handle: "alice", address: ADDR })
    expect(gate).not.toHaveBeenCalled()
  })

  it("the cached key, which carries no name, enters under the name a reload carried", async () => {
    await rolledOver()
    const options = { signIn: signInDeps, contractService: {} as never, gate, tiers: [] }

    expect(await enterWithPasskey(wallet, page, undefined, options)).toMatchObject({
      entered: false,
      reason: "confirm",
    })
    expect(
      await enterWithPasskey(wallet, page, undefined, { ...options, named: "alice" }),
    ).toMatchObject({ entered: true, handle: "alice", address: ADDR })
    // A carried name is checked against the claim like any other.
    expect(
      await enterWithPasskey(wallet, page, undefined, { ...options, named: "bob" }),
    ).toMatchObject({ entered: false, reason: "confirm" })
  })

  it("refuses the name when the record names another L2 address, and adopts nothing", async () => {
    await rolledOver()
    h.recordedL2.mockReturnValue(`0x${"cc".repeat(32)}`)

    await expect(
      enterWithPasskey(wallet, page, "alice", {
        signIn: signInDeps,
        contractService: {} as never,
        gate,
        tiers: [],
      }),
    ).rejects.toThrow(/cannot confirm/)
    expect(h.addWebauthnAccount).not.toHaveBeenCalled()
  })
})

describe("evidence the wallet cannot read is never read as a new user", () => {
  it("the stored session refuses when the profile publishes no generation, and adopts nothing", async () => {
    published.catalog = []

    await expect(
      enterWithPasskey(wallet, page, undefined, {
        signIn: signInDeps,
        contractService: {} as never,
        gate,
        tiers: [],
      }),
    ).rejects.toThrow(/cannot say which account/)
    expect(h.commitSecret).not.toHaveBeenCalled()
    expect(h.addWebauthnAccount).not.toHaveBeenCalled()
  })

  it("a cold sign-in refuses when every published generation binds another registry", async () => {
    published.catalog = CATALOG.map((entry) => ({ ...entry, rollupVersion: "6" }))
    h.recoverFromCache.mockResolvedValue({ ...held, expectedAddress: undefined })

    await expect(
      enterWithPasskey(wallet, page, undefined, {
        signIn: signInDeps,
        contractService: {} as never,
        gate,
        tiers: [{ name: "registry", probes: [async () => "anchored" as const] }],
      }),
    ).rejects.toThrow(/cannot say which account/)
    expect(h.commitSecret).not.toHaveBeenCalled()
    expect(h.addWebauthnAccount).not.toHaveBeenCalled()
  })
})

describe("a record the chain's list has moved past", () => {
  const options = () => ({ signIn: signInDeps, contractService: {} as never, gate, tiers: [] })
  const MARK = "zkm.once.movedAccount"
  let stash: Map<string, string>

  beforeEach(async () => {
    const { composeWireNameHash } = await import("@obsidion/front-core")
    stash = new Map()
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => stash.get(key) ?? null,
      setItem: (key: string, value: string) => void stash.set(key, value),
      removeItem: (key: string) => void stash.delete(key),
    })
    // The tag's account is named, and its user record names the two-key address.
    h.readNameOf.mockResolvedValue(composeWireNameHash("alice", "zkmoney.eth"))
    h.recordedL2.mockReturnValue(NEW)
    h.authKeys.mockResolvedValue(listing([PUBKEY, BACKUP]))
  })

  const nothingWritten = () => {
    expect(h.commitSecret).not.toHaveBeenCalled()
    expect(h.recordRecoveryMetadata).not.toHaveBeenCalled()
    expect(h.addWebauthnAccount).not.toHaveBeenCalled()
    expect(stash.get(MARK)).toBeUndefined()
  }

  const enteredMoved = () => {
    expect(h.providerFor).toHaveBeenCalledWith({
      credentialId: "cred",
      pubkeyHex: PUBKEY,
      passkeys: [PUBKEY, BACKUP],
    })
    // The record is rewritten after the commit, to the new address under both keys.
    expect(h.commitSecret.mock.invocationCallOrder[0]).toBeLessThan(
      h.recordRecoveryMetadata.mock.invocationCallOrder[0]!,
    )
    expect(h.recordRecoveryMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialId: "cred",
        l2Address: NEW,
        pubkey: PUBKEY,
        passkeySet: [PUBKEY, BACKUP],
        isMskRoot: true,
      }),
      expect.any(Function),
    )
    expect(h.markRecordsStale).toHaveBeenCalled()
    // The snapshot names the two-key account, signed by the held credential.
    expect(h.addWebauthnAccount).toHaveBeenCalledWith({
      type: "saved",
      completeAddress: `${NEW}:complete`,
      signer: { credentialId: "cred", pubkey: PUBKEY, authenticatorType: "platform" },
    })
    expect(stash.get(MARK)).toBe(NEW)
  }

  it("the cached key enters the two-key account and rewrites its record to it", async () => {
    const result = await enterWithPasskey(wallet, page, "alice", options())
    expect(result).toMatchObject({ entered: true, handle: "alice", address: NEW })
    expect(gate).not.toHaveBeenCalled()
    enteredMoved()
  })

  it("a sign-in pinned to the record, answered from the cache, enters the same way", async () => {
    const result = await enterWithPasskey(wallet, page, "alice", {
      ...options(),
      hints: { credentialId: "cred", chosen: true },
      restoreCache: false,
    })
    expect(result).toMatchObject({ entered: true, handle: "alice", address: NEW })
    enteredMoved()
  })

  it("a sign-in pinned to the record, answered by a ceremony, enters the same way", async () => {
    h.recoverFromCache.mockResolvedValue(undefined)
    h.beginRecovery.mockResolvedValue(held)
    const result = await enterWithPasskey(wallet, page, "alice", {
      ...options(),
      hints: { credentialId: "cred", chosen: true },
    })
    expect(result).toMatchObject({ entered: true, handle: "alice", address: NEW })
    expect(gate).toHaveBeenCalledTimes(1)
    enteredMoved()
  })

  it("the arrival probe enters the two-key account and asks the name to be confirmed", async () => {
    const result = await enterWithPasskey(wallet, page, undefined, {
      ...options(),
      cacheOnly: true,
    })
    expect(result).toMatchObject({ entered: false, reason: "confirm", claim: { address: NEW } })
    enteredMoved()
  })

  it.each([
    ["the key alone", listing([PUBKEY])],
    ["three keys", listing([PUBKEY, BACKUP, "cd".repeat(64)])],
    ["two keys without the held one", listing(["cd".repeat(64), BACKUP])],
  ])("with %s on the chain the refusal stands and nothing is written", async (_shape, list) => {
    h.authKeys.mockResolvedValue(list)
    await expect(enterWithPasskey(wallet, page, "alice", options())).rejects.toThrow(
      /cannot confirm/,
    )
    nothingWritten()
  })

  it("a failed key read leaves the refusal as it was", async () => {
    h.authKeys.mockRejectedValue(new Error("rpc down"))
    await expect(enterWithPasskey(wallet, page, "alice", options())).rejects.toThrow(
      /cannot confirm/,
    )
    nothingWritten()
  })

  it("a cancel during the key read ends in the cancel, with nothing written", async () => {
    const op = new AbortController()
    h.authKeys.mockImplementationOnce(async () => {
      op.abort()
      return listing([PUBKEY, BACKUP])
    })
    await expect(
      enterWithPasskey(wallet, page, "alice", { ...options(), signal: op.signal }),
    ).rejects.toSatisfy(isGateCancelled)
    nothingWritten()
  })

  it("a failed save past the commit leaves no notice", async () => {
    h.addWebauthnAccount.mockRejectedValueOnce(new Error("disk full"))
    await expect(enterWithPasskey(wallet, page, "alice", options())).rejects.toMatchObject({
      message: "disk full",
      committed: true,
    })
    expect(stash.get(MARK)).toBeUndefined()
  })
})
