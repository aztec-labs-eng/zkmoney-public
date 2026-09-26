// @vitest-environment node
/**
 * A fresh-browser sign-in over the real auth service and real P-256 signatures, with only an anchor
 * that looks at the master key (as the campaign's signup record does). The key the L1 account
 * installed is the credential's own, so the sign-in takes one assertion and adopts that key; with
 * no installed key the second assertion recovers the same one.
 */
import { Fr } from "@aztec/aztec.js/fields"
import type { AnchorTier, CandidateProbe } from "@obsidion/front-core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WebAlphaAuthService } from "../src/platform/auth/WebAlphaAuthService"
import { getActiveStorageId, readCachedMsk } from "../src/platform/storage/activeStorage"
import { FakePasskeyCeremony, MemoryStorage } from "./support/fakePasskeyCeremony"

const h = vi.hoisted(() => ({
  service: undefined as unknown,
  addWebauthnAccount: vi.fn(),
  getCode: vi.fn(),
  readAuthKeys: vi.fn(),
  /** The hand-off's anchor tiers; the entry tests pass theirs explicitly. */
  tiers: [] as AnchorTier[],
}))

vi.mock("../src/platform/auth/useAuthenticator", () => ({ getAuthService: () => h.service }))
vi.mock("../src/platform/storage/handoffMaterial", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/platform/storage/handoffMaterial")>()),
  awaitHandoffMaterial: async () => null,
}))
vi.mock("../src/features/onboarding/recoveryProbes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/onboarding/recoveryProbes")>()),
  anchorTiers: () => h.tiers,
}))
vi.mock("../src/config/env", () => ({ getConfig: () => ({ rpId: "localhost" }) }))
vi.mock("../src/config/oxideTuple", () => ({
  getOxideTuple: async () => ({
    accountFactory: `0x${"11".repeat(20)}`,
    registry: `0x${"22".repeat(20)}`,
    ensDomain: "zkmoney.eth",
  }),
  requireTupleField: (tuple: Record<string, string>, key: string) => tuple[key],
  l1PublicClient: () => ({}),
}))
/** One published generation that admits, holding no name: the legitimate new-user control. */
const unnamedGenerations = {
  reader: {
    predictAccountAddress: async () => `0x${"33".repeat(20)}`,
    readNameOf: async () => `0x${"0".repeat(64)}`,
    readAccountMetadataRegistry: async () => `0x${"23".repeat(20)}`,
    readUserRecord: async () => null,
    readNamePortalRegistry: async () => `0x${"22".repeat(20)}`,
    readFactoryImplementation: async () => `0x${"11".repeat(19)}dd`,
  },
  registry: `0x${"22".repeat(20)}`,
  rollupVersion: "1",
  catalog: [
    {
      fpcAddress: `0x${"0b".repeat(32)}`,
      accountFactory: `0x${"11".repeat(20)}`,
      implementation: `0x${"11".repeat(19)}dd`,
      namePortal: `0x${"11".repeat(19)}ee`,
      rollupVersion: "1",
    },
  ],
}
vi.mock("../src/features/onboarding/oxideGenerations", () => ({
  loadOxideGenerations: async () => unnamedGenerations,
  generationFactories: () => [`0x${"11".repeat(20)}`],
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  AccountStorage: { get: () => ({ addWebauthnAccount: h.addWebauthnAccount }) },
  createOxideL1Reader: () => ({
    predictAccountAddress: async () => `0x${"33".repeat(20)}`,
    readNameOf: async () => `0x${"0".repeat(64)}`,
    getCode: h.getCode,
    readAuthKeys: h.readAuthKeys,
  }),
}))

const { adoptHandoff, enterWithPasskey, resolveHandoff } = await import(
  "../src/features/onboarding/oxideOnboarding"
)
const { credentialIdToMetadata } = await import("@obsidion/front-core")

const ADDR = `0x${"aa".repeat(32)}`
const account = {
  getAddress: () => ({ toString: () => ADDR }),
  getCompleteAddress: () => ({ toString: () => `${ADDR}:complete` }),
}
const config = { rpId: "localhost" } as never

/** A gate that starts one attempt, picks `route`, and lets the approve-again tap through. */
function gateFor(route?: "this-device" | "phone" | "security-key") {
  const controller = new AbortController()
  const gate = vi.fn(async (options?: { again?: AbortSignal }) => ({
    signal: options?.again ?? controller.signal,
    reach: "unknown" as const,
    ...(route ? { route } : {}),
  }))
  return { gate, controller }
}

const serviceOver = (ceremony: FakePasskeyCeremony) =>
  new WebAlphaAuthService({
    storage: new MemoryStorage(),
    rpId: "localhost",
    ceremony,
    posture: () => "phone",
  })

/** A laptop whose browser labels a cross-device answer as its own, or one that does not. */
const laptopOver = (ceremony: FakePasskeyCeremony, misreportsCrossDevice: boolean) =>
  new WebAlphaAuthService({
    storage: new MemoryStorage(),
    rpId: "localhost",
    ceremony,
    posture: () => "laptop",
    misreportsCrossDevice: () => misreportsCrossDevice,
  })

/** A passkey created on one browser, and a second browser with nothing stored signing in with it. */
async function freshBrowserWithPasskey(manager: "icloud" | "gpm" = "icloud") {
  const ceremony = new FakePasskeyCeremony({ route: "local", manager })
  const created = await serviceOver(ceremony).createPasskey("@alice")
  h.service = serviceOver(ceremony)
  ceremony.asserts.length = 0
  const createObsidionAccount = vi.fn(async () => account)
  // Only the passkey's own master key AND its own signing key derive the account.
  const deriveAccountAddress = vi.fn(async (msk: Fr, pubkeyHex: string) => ({
    toString: () =>
      msk.equals(created.secretKey) && pubkeyHex === created.pubkey ? ADDR : `0x${"bb".repeat(32)}`,
  }))
  const wallet = { deriveAccountAddress, createObsidionAccount }
  return { ceremony, created, wallet, createObsidionAccount, deriveAccountAddress }
}

const store = new Map<string, string>()
/**
 * What this browser holds, for asserting that a refusal wrote nothing. The environment record is
 * diagnostics, written for every ceremony whether refused or not, so it is left out.
 */
const held = () => JSON.stringify([...store].filter(([k]) => k !== "webwallet.passkeyEnv").sort())

beforeEach(() => {
  vi.clearAllMocks()
  store.clear()
  h.tiers = []
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  h.getCode.mockResolvedValue(undefined)
  h.readAuthKeys.mockResolvedValue([])
})
afterEach(() => vi.unstubAllGlobals())

describe("a sign-in anchored only by the master key adopts the credential's real key", () => {
  const masterKeyOnly = (secret: Fr): AnchorTier[] => {
    const probe: CandidateProbe = async (msk) => (msk.equals(secret) ? "anchored" : "absent")
    return [{ name: "campaign", probes: [probe] }]
  }

  it("the installed key settles the sign-in in one assertion", async () => {
    const { ceremony, created, wallet, createObsidionAccount, deriveAccountAddress } =
      await freshBrowserWithPasskey()
    h.getCode.mockResolvedValue("0x6080")
    h.readAuthKeys.mockResolvedValue([
      {
        key: { qx: `0x${created.pubkey.slice(0, 64)}`, qy: `0x${created.pubkey.slice(64)}` },
        metadata: credentialIdToMetadata(created.credentialId),
      },
    ])
    const { gate } = gateFor()
    const result = await enterWithPasskey(wallet as never, config, undefined, {
      contractService: {} as never,
      gate,
      tiers: masterKeyOnly(created.secretKey),
      chooser: true,
    })
    expect(result).toMatchObject({ entered: false, reason: "unclaimed" })
    expect(h.readAuthKeys).toHaveBeenCalled()
    expect(ceremony.asserts).toHaveLength(1)
    expect(gate).toHaveBeenCalledTimes(1)
    expect(new Set(deriveAccountAddress.mock.calls.map(([, key]) => key))).toEqual(
      new Set([created.pubkey]),
    )
    expect(createObsidionAccount).toHaveBeenCalledWith(created.secretKey, expect.anything())
    expect(h.addWebauthnAccount).toHaveBeenCalledWith(
      "Account 1",
      `${ADDR}:complete`,
      expect.objectContaining({ credentialId: created.credentialId, pubkey: created.pubkey }),
    )
  })

  it("with no installed key the second assertion recovers the same key", async () => {
    const { ceremony, created, wallet, deriveAccountAddress } = await freshBrowserWithPasskey()
    const { gate } = gateFor()
    const result = await enterWithPasskey(wallet as never, config, undefined, {
      contractService: {} as never,
      gate,
      tiers: masterKeyOnly(created.secretKey),
      chooser: true,
    })
    expect(result).toMatchObject({ entered: false, reason: "unclaimed" })
    expect(ceremony.asserts).toHaveLength(2)
    expect(gate).toHaveBeenCalledTimes(2)
    expect(new Set(deriveAccountAddress.mock.calls.map(([, key]) => key))).toEqual(
      new Set([created.pubkey]),
    )
    expect(h.addWebauthnAccount).toHaveBeenCalledWith(
      "Account 1",
      `${ADDR}:complete`,
      expect.objectContaining({ pubkey: created.pubkey }),
    )
  })

  describe("on a laptop whose browser mislabels a cross-device answer", () => {
    /**
     * The phone's passkey, signed in from a laptop; `route` is which copy answers. Google Password
     * Manager derives differently per route, so the two routes reach the account by different slots.
     */
    async function laptopSignIn(route: "cross-device" | "local", misreports = true) {
      const setup = await freshBrowserWithPasskey("gpm")
      setup.ceremony.opts.route = route
      setup.ceremony.opts.attachment = "platform"
      h.service = laptopOver(setup.ceremony, misreports)
      const recorded = vi.spyOn(h.service as WebAlphaAuthService, "recordRecoveryMetadata")
      return { ...setup, recorded }
    }
    const signIn = (wallet: unknown, tiers: AnchorTier[]) =>
      enterWithPasskey(wallet as never, config, undefined, {
        contractService: {} as never,
        gate: gateFor("phone").gate,
        tiers,
        chooser: true,
      })

    /**
     * The account was built from the passkey's own master key, stored under it, and that key is
     * the one the session now holds, in memory and in the cache the next load restores from.
     */
    const committedTheAccount = async (
      created: { secretKey: Fr; pubkey: string; credentialId: string },
      createObsidionAccount: ReturnType<typeof vi.fn>,
    ) => {
      expect(createObsidionAccount).toHaveBeenCalledTimes(1)
      expect(createObsidionAccount).toHaveBeenCalledWith(created.secretKey, expect.anything())
      expect(h.addWebauthnAccount).toHaveBeenCalledWith(
        "Account 1",
        `${ADDR}:complete`,
        expect.objectContaining({ pubkey: created.pubkey }),
      )
      const service = h.service as WebAlphaAuthService
      expect((await service.getSecretKey())?.toString()).toBe(created.secretKey.toString())
      expect(readCachedMsk()).toMatchObject({
        credentialId: created.credentialId,
        msk: created.secretKey.toString(),
      })
      expect(getActiveStorageId()).toBe(readCachedMsk()?.storageId)
    }
    const committedNothing = (createObsidionAccount: ReturnType<typeof vi.fn>, before: string) => {
      expect(createObsidionAccount).not.toHaveBeenCalled()
      expect(h.addWebauthnAccount).not.toHaveBeenCalled()
      expect(held()).toBe(before)
    }

    it("the phone over QR, mislabelled: the anchored candidate is committed, from the QR slot", async () => {
      const { created, wallet, recorded, createObsidionAccount } = await laptopSignIn(
        "cross-device",
      )
      const result = await signIn(wallet, masterKeyOnly(created.secretKey))
      expect(result).toMatchObject({ entered: false, reason: "unclaimed" })
      await committedTheAccount(created, createObsidionAccount)
      expect(recorded.mock.calls[0]?.[0]).toMatchObject({ prfSlot: "first" })
    })

    it("this Mac's own synced copy, honestly labelled: the same account, from the local slot", async () => {
      const { created, wallet, recorded, createObsidionAccount } = await laptopSignIn("local")
      const result = await signIn(wallet, masterKeyOnly(created.secretKey))
      expect(result).toMatchObject({ entered: false, reason: "unclaimed" })
      await committedTheAccount(created, createObsidionAccount)
      expect(recorded.mock.calls[0]?.[0]).toMatchObject({ prfSlot: "second" })
    })

    it("without the flag a local answer is admitted too, and anchored from the local slot", async () => {
      // The flag only corrects a mislabel; it no longer gates whether this Mac's own copy may answer.
      const { created, wallet, recorded, createObsidionAccount } = await laptopSignIn("local", false)
      const result = await signIn(wallet, masterKeyOnly(created.secretKey))
      expect(result).toMatchObject({ entered: false, reason: "unclaimed" })
      await committedTheAccount(created, createObsidionAccount)
      expect(recorded.mock.calls[0]?.[0]).toMatchObject({ prfSlot: "second" })
    })

    it("a diverged read matches no anchor and commits nothing", async () => {
      const { ceremony, created, wallet, createObsidionAccount } = await laptopSignIn("local")
      ceremony.creds.get(created.credentialId)!.secret = new Uint8Array(32).fill(7)
      const before = held()
      const result = await signIn(wallet, masterKeyOnly(created.secretKey))
      expect(result).toMatchObject({ entered: false, reason: "unknown" })
      committedNothing(createObsidionAccount, before)
    })

    it("no anchor for either candidate commits nothing", async () => {
      const { wallet, createObsidionAccount } = await laptopSignIn("cross-device")
      const before = held()
      const absent: CandidateProbe = async () => "absent"
      const result = await signIn(wallet, [{ name: "campaign", probes: [absent] }])
      expect(result).toMatchObject({ entered: false, reason: "unknown" })
      committedNothing(createObsidionAccount, before)
    })

    it("an anchor that names both candidates, or cannot answer, commits nothing", async () => {
      const { wallet, createObsidionAccount } = await laptopSignIn("cross-device")
      const before = held()
      const both: CandidateProbe = async () => "anchored"
      await expect(signIn(wallet, [{ name: "campaign", probes: [both] }])).rejects.toMatchObject({
        name: "AmbiguousPasskeyError",
      })
      const down: CandidateProbe = async () => {
        throw new Error("campaign unreachable")
      }
      await expect(signIn(wallet, [{ name: "campaign", probes: [down] }])).rejects.toThrow(
        /unreachable/,
      )
      committedNothing(createObsidionAccount, before)
    })

    describe("a campaign hand-off whose material was missed, resolved on the same laptop", () => {
      const hintsFor = (created: { credentialId: string; pubkey: string }) => ({
        credentialId: created.credentialId,
        pubkeyHex: created.pubkey,
      })

      it("adopts the hinted account when an anchor names it, and only on adoption", async () => {
        const { created, wallet, createObsidionAccount } = await laptopSignIn("cross-device")
        h.tiers = masterKeyOnly(created.secretKey)
        const resolved = await resolveHandoff(
          wallet as never,
          {} as never,
          config,
          hintsFor(created),
          gateFor("phone").gate,
        )
        expect(resolved.msk.equals(created.secretKey)).toBe(true)
        expect(resolved.slot).toBe("first")
        expect(createObsidionAccount).not.toHaveBeenCalled()
        const keys = await adoptHandoff(wallet as never, resolved)
        expect(keys.secretKey.equals(created.secretKey)).toBe(true)
        await committedTheAccount(created, createObsidionAccount)
      })

      it("refuses with nothing written when no anchor names either candidate", async () => {
        const { created, wallet, createObsidionAccount } = await laptopSignIn("local")
        h.tiers = [{ name: "campaign", probes: [async () => "absent"] }]
        const before = held()
        await expect(
          resolveHandoff(wallet as never, {} as never, config, hintsFor(created), gateFor("phone").gate),
        ).rejects.toMatchObject({ name: "NoWalletForPasskeyError" })
        committedNothing(createObsidionAccount, before)
      })
    })
  })
})
