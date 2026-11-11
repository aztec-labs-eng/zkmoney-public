/**
 * The browser's migration run is one session's: the account signed in under another passkey ends
 * its writes and its consent prompts, as another account signed in does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fakeReads } from "../../support/fakeReads"

const h = vi.hoisted(() => ({
  session: vi.fn(async (o: unknown) => o),
  sign: vi.fn(async () => ({ signature: "0x01" })),
}))

vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(({ openDatabase, memoryStore, queries, ACROSS_INPUT_DECIMALS }) => ({
    openDatabase,
    memoryStore,
    queries,
    ACROSS_INPUT_DECIMALS,
  }))(await importOriginal<typeof import("@obsidion/front-core")>()),
  createMetadataMigrationSession: h.session,
  pubkeyToR1KeyArg: (hex: string) => ({ qx: hex, qy: hex }),
  UpgradeActivity: { get: () => ({}) },
  WalletSyncCoordinator: {},
  BROADCASTS_STORAGE_KEY: "broadcasts",
  OPERATIONS_STORAGE_KEY: "operations",
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  createLocalMetadataMigrationSource: vi.fn(),
  FrozenMetadataMigrationSource: class {},
  frozenRuntimeFromSourceGeneration: vi.fn(),
}))
vi.mock("../../../src/config/oxideTuple", () => ({
  l1MulticallClient: () => ({}),
}))
vi.mock("../../../src/session/account", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/session/account")>()),
  collectOnboardingKeys: async () => ({ secretKey: {}, pubkeyHex: "0x04ab", authProvider: {} }),
}))
vi.mock("../../../src/features/registration/claimSponsorship", () => ({
  claimSponsorContext: vi.fn(),
}))
vi.mock("../../../src/features/token/oxideToken", () => ({ portalContract: vi.fn() }))
vi.mock("../../../src/features/migration/historicTokenContext", () => ({
  sourceChain: vi.fn(),
  historicTokenContext: vi.fn(),
}))
vi.mock("../../../src/features/migration/sourceSipaSources", () => ({
  sourceSweptDeposits: vi.fn(),
}))

const { createWebMetadataMigration } = await import(
  "../../../src/features/migration/createWebMetadataMigration"
)
const { seedDeviceKeys, testCore } = await import("../../support/page")
const { webStorage } = await import("../../../src/platform/storage/WebStorageAdapter")
const { SessionChangedError } = await import("../../../src/platform/auth/sessionErrors")
const { FakeLocks } = await import("../../support/fakeLocks")
const { SourceBusyError } = await import("../../../src/features/migration/migrationErrors")

type Run = {
  lock<T>(fn: () => Promise<T>): Promise<T>
  lockNow<T>(fn: () => Promise<T>): Promise<T>
  storage: { setItem(key: string, value: string): Promise<void> }
  passkey: { signChallenge(digest: `0x${string}`, opts?: unknown): Promise<unknown> }
}

const tuple = { portal: `0x${"ab".repeat(20)}` } as never
const account = { getAddress: () => `0x${"01".repeat(32)}` } as never

beforeEach(() => {
  localStorage.clear()
  h.sign.mockClear()
})

async function compose(): Promise<Run> {
  await seedDeviceKeys({ storageId: "wallet-1", credentialId: "cred-a" })
  const run = await createWebMetadataMigration({
    wallet: {} as never,
    account,
    deposits: { get: async () => undefined },
    auth: { signMetadataChallenge: h.sign } as never,
    own: {
      page: {
        config: { network: "sandbox" },
        chain: fakeReads({ feeTokenBridgeTuple: async () => tuple }),
      },
      namespace: { id: "wallet-1" },
      device: testCore().device,
      balanceStore: {},
      transfers: { all: async () => [] },
    } as never,
    handle: undefined,
    contractService: {} as never,
    toTokenService: {} as never,
    historic: tuple,
    current: tuple,
  })
  return run as unknown as Run
}

describe("the browser's migration run", () => {
  it("writes and asks consent while its session stays", async () => {
    const run = await compose()
    await run.storage.setItem("k", "v")
    expect(await webStorage.getItem("k")).toBe("v")
    await run.passkey.signChallenge("0xaa")
    expect(h.sign).toHaveBeenCalledWith("0xaa", undefined)
  })

  it("ends once the account is signed in under another passkey", async () => {
    const run = await compose()
    await seedDeviceKeys({ credentialId: "cred-b" })
    await expect(run.storage.setItem("k", "v")).rejects.toThrow(SessionChangedError)
    expect(() => run.passkey.signChallenge("0xaa")).toThrow(SessionChangedError)
    expect(h.sign).not.toHaveBeenCalled()
  })

  it("refuses lockNow while a pass holds the lock, and runs it once the pass ends", async () => {
    vi.stubGlobal("navigator", { ...navigator, locks: new FakeLocks() })
    const run = await compose()
    let endPass = () => {}
    const pass = run.lock(() => new Promise<void>((resolve) => (endPass = resolve)))
    await expect(run.lockNow(async () => "ran")).rejects.toThrow(SourceBusyError)
    endPass()
    await pass
    await expect(run.lockNow(async () => "ran")).resolves.toBe("ran")
    vi.unstubAllGlobals()
  })

  it("ends once another account is signed in", async () => {
    const run = await compose()
    await seedDeviceKeys({ storageId: "wallet-2" })
    await expect(run.storage.setItem("k", "v")).rejects.toThrow(SessionChangedError)
  })
})
