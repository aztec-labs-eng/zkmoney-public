// @vitest-environment node
import { BackupRotationStore } from "@obsidion/front-core"
import {
  encodeUserHandle,
  runBackupPasskeyCreation,
  type PasskeyCeremony,
} from "@obsidion/passkey-web"
import { ContractService, type FundingAmount, type ObsidionWallet } from "@obsidion/sdk"
import type { Address } from "viem"
import { describe, expect, it, vi } from "vitest"
import { OWNER as RECORD_OWNER, PLAN, signedRecord, storedRotation } from "./support/backupAdd"
import { MemoryStorage } from "./support/fakePasskeyCeremony"

// What the flow's dependencies read off the session and the other services, set per test.
const fakes = vi.hoisted(() => ({
  store: {} as unknown,
  keys: undefined as unknown,
  sponsor: { fpcAddress: { fpc: true }, fpcArtifact: { artifact: true } },
  tokenService: { setTeeSigner: vi.fn(), sendTokenSponsored: vi.fn(async () => undefined) },
}))

const h = vi.hoisted(() => ({ auth: { providerFor: () => ({}) } as Record<string, unknown> }))
vi.mock("../src/platform/auth/useAuthenticator", () => ({ getAuthService: () => h.auth }))
vi.mock("../src/features/identity/walletIdentity", () => ({ loadWalletIdentity: () => null }))
vi.mock("../src/features/backupPasskey/backupRotationStore", () => ({
  getBackupRotationStore: () => fakes.store,
}))
vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: () => ({ l1ChainId: 11155111 }),
}))
vi.mock("../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/oxideTuple")>()),
  getFeeTokenBridgeTuple: async () => ({
    plainWithdrawalExecutor: `0x${"e8".repeat(20)}`,
    l2Token: `0x${"2a".repeat(32)}`,
  }),
  l1PublicClient: () => ({}),
  oxideEnvFor: async () => ({ resolver: { owner: `0x${"0d".repeat(20)}` } }),
}))
vi.mock("../src/platform/storage/activeStorage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/platform/storage/activeStorage")>()),
  getActiveCredentialId: () => "root-credential",
}))
vi.mock("../src/features/onboarding/registrationResume", async (importOriginal) => {
  const real = await importOriginal<
    typeof import("../src/features/onboarding/registrationResume")
  >()
  return {
    ...real,
    unlockedSessionKeys: (async (...args) =>
      fakes.keys ?? real.unlockedSessionKeys(...args)) as typeof real.unlockedSessionKeys,
  }
})
vi.mock("../src/features/token/oxideToken", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/token/oxideToken")>()),
  currentTxAmountCap: async () => 2n * 10n ** 18n,
  teeSignerOfToken: async () => ({}),
}))
vi.mock("../src/features/token/l2TokenService", () => ({
  l2TokenService: () => fakes.tokenService,
}))
vi.mock("../src/features/onboarding/claimSponsorship", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/onboarding/claimSponsorship")>()),
  claimSponsorContext: async () => fakes.sponsor,
}))
vi.mock("../src/features/fees/fpcRefuel", () => ({ maybeRefuelFpc: vi.fn() }))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  readBridgeDestination: async () => ({}),
}))

const { backupUserName, buildBackupAddDeps, buildBackupFlowDeps, signedChangeFor, sweepFunding } =
  await import("../src/features/backupPasskey/backupPasskeyRuntime")
const { maybeRefuelFpc } = await import("../src/features/fees/fpcRefuel")

const OWNER = `0x${"ab".repeat(20)}` as Address

describe("buildBackupAddDeps", () => {
  it("creates through the auth service under the session's name, with the pick and the signal", async () => {
    const secret = Buffer.alloc(32, 7)
    const seen: Record<string, unknown>[] = []
    const creation = { kind: "creation" }
    Object.assign(h.auth, {
      sessionKeys: async () => ({
        secretKey: { toBuffer: () => secret },
        authProvider: { getPubkeys: async () => [Buffer.alloc(32, 1), Buffer.alloc(32, 2)] },
      }),
      createBackupPasskey: async (
        driver: unknown,
        ceremony: unknown,
        opts: Record<string, unknown>,
      ) => {
        seen.push({ driver, ceremony, ...opts })
        return creation
      },
    })
    const wallet = { createObsidionAccount: async () => ({}) } as unknown as ObsidionWallet
    const ceremony = { kind: "ceremony" } as unknown as PasskeyCeremony
    const observe = () => {}
    const signal = new AbortController().signal

    const picked = await buildBackupAddDeps({ wallet, owner: OWNER, choice: "phone" })
    expect(picked.owner).toBe(OWNER)
    expect(picked.masterKey()).toEqual(new Uint8Array(secret))
    await expect(picked.create(ceremony, observe, signal)).resolves.toBe(creation)
    expect(seen[0]).toEqual({
      driver: runBackupPasskeyCreation,
      ceremony,
      userName: "0xabab…abab",
      choice: "phone",
      observe,
      signal,
    })

    const unpicked = await buildBackupAddDeps({ wallet, owner: OWNER })
    await unpicked.create(ceremony, observe)
    expect(seen[1]).toEqual({
      driver: runBackupPasskeyCreation,
      ceremony,
      userName: "0xabab…abab",
      observe,
    })
  })
})

describe("backupUserName", () => {
  it("uses the tag when the identity has one", () => {
    expect(backupUserName("brave-otter-42", OWNER)).toBe("brave-otter-42")
  })

  it("falls back to a short owner the user handle accepts", () => {
    for (const handle of [undefined, ""]) {
      const name = backupUserName(handle, OWNER)
      expect(name).toBe("0xabab…abab")
      expect(() => encodeUserHandle(name)).not.toThrow()
    }
    expect(() => encodeUserHandle(OWNER)).toThrow()
  })
})

describe("sweepFunding", () => {
  const live = (over: Partial<FundingAmount["breakdown"]> = {}): FundingAmount => {
    const breakdown = {
      withdrawalFee: 10n,
      proverTip: 0n,
      relayerTip: 5n,
      sweepTip: 7n,
      beneficiaryFee: 3n,
      minCredited: 100n,
      margin: 50n,
      ...over,
    }
    const credited = breakdown.minCredited + breakdown.margin
    const b = breakdown
    return {
      amount:
        b.withdrawalFee + b.proverTip + b.relayerTip + b.sweepTip + b.beneficiaryFee + credited,
      credited,
      breakdown,
    }
  }

  it("is what the deposit address holds once the funding is withdrawn: the live amount before a plan, the saved one after", () => {
    expect(sweepFunding(live(), undefined)).toBe(7n + 3n + 150n)
    expect(sweepFunding(live(), "175")).toBe(160n)
  })

  it("refuses a saved funding the route's current charges no longer leave sweepable", () => {
    expect(sweepFunding(live({ withdrawalFee: 70n }), "175")).toBeUndefined()
    expect(sweepFunding(live({ minCredited: 200n }), "175")).toBeUndefined()
    expect(sweepFunding(live({ sweepTip: 60n }), "175")).toBeUndefined()
  })
})

describe("signedChangeFor", () => {
  const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}`
  const rotation = {
    expectedKeys: [{ key: { qx: word(14), qy: word(15) } }],
    builtOver: { l2Address: word(10) },
    add: { pubkey: { qx: word(21), qy: word(22) } },
  }
  const root = `${word(14).slice(2)}${word(15).slice(2)}`

  it("names the account the change was built over and the key it adds, for the root that signed it", () => {
    expect(signedChangeFor(rotation, root.toUpperCase())).toEqual({
      source: word(10),
      add: `${word(21).slice(2)}${word(22).slice(2)}`,
    })
  })

  it("refuses a session signed in with another passkey", () => {
    const other = `${word(21).slice(2)}${word(22).slice(2)}`
    expect(() => signedChangeFor(rotation, other)).toThrow("first passkey")
    expect(() => signedChangeFor({ ...rotation, expectedKeys: [] }, root)).toThrow("first passkey")
  })

  it("refuses a record with nothing signed", () => {
    expect(() => signedChangeFor(undefined, root)).toThrow("nothing signed")
  })
})

describe("the move's send", () => {
  it("checks the sponsor's fuel once a chunk went out, and not after a send that failed", async () => {
    const rotation = storedRotation()
    const root = rotation.expectedKeys[0]!.key
    const source = rotation.builtOver.l2Address
    fakes.keys = {
      secretKey: {},
      pubkeyHex: `0x${root.qx.slice(2)}${root.qy.slice(2)}`,
      account: {},
      authProvider: {},
    }
    const store = new BackupRotationStore(new MemoryStorage())
    await store.put(signedRecord({ phase: "rerooted" }))
    fakes.store = store
    const contractService = { contractService: true }
    vi.spyOn(ContractService, "getInstance").mockReturnValue(contractService as never)
    // The one-key account is the signed change's source; the two-key address is the plan's.
    const wallet = {
      deriveAccountAddress: async (_secret: unknown, set: string[]) => ({
        toString: () => (set.length === 1 ? source : PLAN.address),
      }),
      createObsidionAccount: async () => ({ getAddress: () => ({ toString: () => source }) }),
      node: {},
    } as unknown as ObsidionWallet

    const deps = await buildBackupFlowDeps({ wallet, owner: RECORD_OWNER })
    await deps.move.send("tok", 1n, vi.fn())
    const send = fakes.tokenService.sendTokenSponsored
    expect(send).toHaveBeenCalledTimes(1)
    expect(maybeRefuelFpc).toHaveBeenCalledTimes(1)
    expect(maybeRefuelFpc).toHaveBeenCalledWith({
      wallet,
      contractService,
      fpc: { address: fakes.sponsor.fpcAddress, artifact: fakes.sponsor.fpcArtifact },
    })
    expect(vi.mocked(maybeRefuelFpc).mock.invocationCallOrder[0]).toBeGreaterThan(
      send.mock.invocationCallOrder[0]!,
    )

    send.mockRejectedValueOnce(new Error("Balance too low"))
    await expect(deps.move.send("tok", 1n, vi.fn())).rejects.toThrow("Balance too low")
    expect(maybeRefuelFpc).toHaveBeenCalledTimes(1)
  })
})
