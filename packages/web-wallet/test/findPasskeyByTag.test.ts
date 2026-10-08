// @vitest-environment node
/**
 * The pinned sign-in behind "find my passkey by tag": `enterWithPasskey` under a credential hint,
 * over the real auth service and the fake authenticator. One assertion pinned to the hinted
 * credential, the same anchors as an open sign-in, a cancel that stops every write wherever it
 * lands, and an `unknown` the glue can tell apart. Plus the lookup glue over the L1 reader.
 */
import { Fr } from "@aztec/aztec.js/fields"
import type { AnchorTier, CandidateProbe } from "@obsidion/front-core"
import { getContractAddress } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { walletStorage } from "../src/platform/storage/walletStorage"
import { WebAlphaAuthService } from "../src/platform/auth/WebAlphaAuthService"
import { WebPasskeyIdentityMap } from "../src/platform/auth/WebPasskeyIdentityMap"
import {
  getActiveCredentialId,
  getActiveStorageId,
  readCachedMsk,
} from "../src/platform/storage/activeStorage"
import { withWebLock } from "../src/platform/storage/webLock"
import { isGateCancelled } from "../src/features/identity/ceremonyGate"
import { FakePasskeyCeremony, MemoryStorage } from "./support/fakePasskeyCeremony"

const h = vi.hoisted(() => ({
  service: undefined as unknown,
  addWebauthnAccount: vi.fn(),
  readNameOf: vi.fn(),
  readAuthKeys: vi.fn(),
  readAuthKeysCounted: vi.fn(),
  getCode: vi.fn(),
  takeHandoffMaterial: vi.fn(),
  resolveTagForCommit: vi.fn(),
  storageIdFromSecret: vi.fn(),
}))

vi.mock("../src/platform/auth/useAuthenticator", () => ({ getAuthService: () => h.service }))
const FACTORY = `0x${"11".repeat(20)}` as const
const identityReader = {
  readNameOf: (...args: unknown[]) => h.readNameOf(...(args as [])),
  readAccountMetadataRegistry: async () => `0x${"23".repeat(20)}`,
  readUserRecord: async () => ({ l2Address: ADDR, rollupVersion: 1n }),
  readNamePortalRegistry: async () => `0x${"22".repeat(20)}`,
  readFactoryImplementation: async () => getContractAddress({ from: FACTORY, nonce: 1n }),
}
vi.mock("../src/features/onboarding/oxideGenerations", () => ({
  loadOxideGenerations: async () => ({
    reader: identityReader,
    registry: `0x${"22".repeat(20)}`,
    rollupVersion: "1",
    catalog: [
      {
        fpcAddress: `0x${"0b".repeat(32)}`,
        accountFactory: FACTORY,
        namePortal: `0x${"11".repeat(19)}ee`,
        rollupVersion: "1",
      },
    ],
  }),
  generationFactories: () => [FACTORY],
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
vi.mock("../src/features/contacts/registryResolution", () => ({
  resolveTagForCommit: h.resolveTagForCommit,
}))
vi.mock("../src/platform/storage/handoffMaterial", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/platform/storage/handoffMaterial")>()),
  takeHandoffMaterial: h.takeHandoffMaterial,
}))
vi.mock("../src/platform/storage/activeStorage", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/platform/storage/activeStorage")>()
  h.storageIdFromSecret.mockImplementation(original.storageIdFromSecret)
  return { ...original, storageIdFromSecret: h.storageIdFromSecret }
})
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  AccountStorage: { get: () => ({ addWebauthnAccount: h.addWebauthnAccount }) },
  createOxideL1Reader: () => ({
    readNameOf: h.readNameOf,
    readAuthKeys: h.readAuthKeys,
    readAuthKeysCounted: h.readAuthKeysCounted,
    getCode: h.getCode,
  }),
}))

const { enterWithPasskey, PasskeyMismatchError } = await import(
  "../src/features/onboarding/oxideOnboarding"
)
const { diagnoseMiss, diagnoseUnknown, lookupPasskeyByTag } = await import(
  "../src/features/onboarding/findPasskeyByTag"
)
const { composeWireNameHash, credentialIdToMetadata } = await import("@obsidion/front-core")

const ADDR = `0x${"aa".repeat(32)}`
const OTHER = `0x${"bb".repeat(32)}`
const ELSEWHERE = `0x${"cc".repeat(32)}`
const config = { rpId: "localhost" } as never
const account = {
  getAddress: () => ({ toString: () => ADDR }),
  getCompleteAddress: () => ({ toString: () => `${ADDR}:complete` }),
}
const anchoring: CandidateProbe = async (_msk, address) =>
  address === ADDR ? "anchored" : "absent"
const registry: AnchorTier[] = [{ name: "registry", probes: [anchoring] }]
const nameOf = (tag: string) => composeWireNameHash(tag, "zkmoney.eth")

type Created = Awaited<ReturnType<WebAlphaAuthService["createPasskey"]>>
const hint = (created: Created) => ({
  credentialId: created.credentialId,
  pubkeyHex: created.pubkey,
})

/** A wallet whose address derivation recognises exactly `secret`. */
function walletFor(secret: Fr, over: Record<string, unknown> = {}) {
  return {
    deriveAccountAddress: async (msk: Fr) => ({
      toString: () => (msk.equals(secret) ? ADDR : OTHER),
    }),
    createObsidionAccount: vi.fn(async () => account),
    ...over,
  } as never
}

/** A phone answering with its own passkey; the service under test is the one `getAuthService` hands out. */
function phone() {
  const ceremony = new FakePasskeyCeremony({ route: "local" })
  const storage = new MemoryStorage()
  const service = new WebAlphaAuthService({
    storage,
    rpId: "localhost",
    ceremony,
    posture: () => "phone",
  })
  h.service = service
  const map = new WebPasskeyIdentityMap(storage, "localhost")
  return { service, ceremony, storage, map }
}

/**
 * A laptop whose own copy answers a this-device request and another device answers the rest;
 * `divergent` makes the local copy return a key the account never used.
 */
function laptop(over: { divergent?: boolean; assertAttachment?: "cross-platform" } = {}) {
  const ceremony = new FakePasskeyCeremony({
    route: "cross-device",
    routeFromRequest: true,
    ...over,
  })
  const storage = new MemoryStorage()
  const service = new WebAlphaAuthService({
    storage,
    rpId: "localhost",
    ceremony,
    posture: () => "laptop",
  })
  h.service = service
  const map = new WebPasskeyIdentityMap(storage, "localhost")
  return { service, ceremony, storage, map }
}

async function record(service: WebAlphaAuthService, created: Created, l2Address: string) {
  await service.recordRecoveryMetadata({
    credentialId: created.credentialId,
    l2Address,
    pubkey: created.pubkey,
    prfSlot: created.prfSlot,
    isMskRoot: true,
  })
}

/** A session entered with `created`: its record, the committed key, the pointers and the cache. */
async function committed(service: WebAlphaAuthService, created: Created) {
  await record(service, created, ADDR)
  await service.commitSecret({ secretKey: created.secretKey, authProvider: created.authProvider })
}

/** The tag this browser remembers for a credential, as `usertagFor` reads it from local storage. */
function remember(created: Created, usertag: string) {
  walletStorage.setItem(
    "obsidion.obsidion_web_passkey_identity_map",
    JSON.stringify({
      version: 1,
      entries: {
        [created.credentialId]: {
          credentialId: created.credentialId,
          rpId: "localhost",
          l2Address: ADDR,
          pubkey: created.pubkey,
          isMskRoot: true,
          createdAt: 1,
          usertag,
        },
      },
    }),
  )
}

/** A gate that starts one attempt, as the real hook does on a phone. */
function gateFor() {
  const controller = new AbortController()
  const gate = vi.fn(async () => ({ signal: controller.signal, reach: "unknown" as const }))
  return { gate, controller }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
async function until(done: () => boolean) {
  while (!done()) await tick()
}

const nothingAdopted = (wallet: { createObsidionAccount: ReturnType<typeof vi.fn> }) => {
  expect(wallet.createObsidionAccount).not.toHaveBeenCalled()
  expect(h.addWebauthnAccount).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  const store = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  h.takeHandoffMaterial.mockReturnValue(null)
  h.readNameOf.mockResolvedValue(nameOf("alice"))
  // No L1 account for an unhinted sign-in's installed-key read.
  h.getCode.mockResolvedValue(undefined)
})
afterEach(() => vi.unstubAllGlobals())

describe("enterWithPasskey under a credential hint", () => {
  it("one assertion pinned to the hinted credential, then the anchors, then the same adoption", async () => {
    const { service, ceremony } = phone()
    const a = await service.createPasskey("@alice")
    ceremony.asserts.length = 0
    const wallet = walletFor(a.secretKey)
    const result = await enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a),
    })
    expect(result).toMatchObject({ entered: true, handle: "alice", address: ADDR })
    expect(ceremony.asserts).toEqual([[a.credentialId]])
    expect(ceremony.assertRequests[0]!.prfSecondSalt).toBeDefined()
    expect(h.takeHandoffMaterial).not.toHaveBeenCalled()
    expect((await service.getSecretKey())?.toString()).toBe(a.secretKey.toString())
    expect(getActiveCredentialId()).toBe(a.credentialId)
    expect(h.addWebauthnAccount).toHaveBeenCalledWith(
      "Account 1",
      `${ADDR}:complete`,
      expect.objectContaining({ credentialId: a.credentialId, pubkey: a.pubkey }),
    )
  })

  it("the pinned request does not depend on the posture the wallet reads", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" })
    const { service, ceremony } = phone()
    const a = await service.createPasskey("@alice")
    ceremony.asserts.length = 0
    await enterWithPasskey(walletFor(a.secretKey), config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a),
    })
    expect(ceremony.asserts).toEqual([[a.credentialId]])
  })

  it("the session's own key answers a hint naming its passkey with no ceremony", async () => {
    const { service, ceremony } = phone()
    const a = await service.createPasskey("@alice")
    await committed(service, a)
    ceremony.asserts.length = 0
    const { gate } = gateFor()
    const result = await enterWithPasskey(walletFor(a.secretKey), config, "alice", {
      contractService: {} as never,
      gate,
      tiers: registry,
      hints: hint(a),
    })
    expect(result).toMatchObject({ entered: true, handle: "alice" })
    expect(ceremony.asserts).toEqual([])
    expect(gate).not.toHaveBeenCalled()
  })

  it("a held key for another passkey does not answer: the ceremony runs pinned to the hint", async () => {
    const { service, ceremony } = phone()
    const a = await service.createPasskey("@alice")
    const c = await service.createPasskey("@carol")
    await committed(service, c)
    ceremony.asserts.length = 0
    const result = await enterWithPasskey(walletFor(a.secretKey), config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a),
    })
    expect(result).toMatchObject({ entered: true, handle: "alice" })
    expect(ceremony.asserts).toEqual([[a.credentialId]])
    expect(getActiveCredentialId()).toBe(a.credentialId)
  })

  it("another credential answering the pinned request is the mismatch refusal, nothing written", async () => {
    const { service, ceremony } = phone()
    const a = await service.createPasskey("@alice")
    const b = await service.createPasskey("@bob")
    ceremony.opts.assertOverride = () => b.credentialId
    const wallet = walletFor(a.secretKey)
    await expect(
      enterWithPasskey(wallet, config, "alice", {
        contractService: {} as never,
        gate: gateFor().gate,
        tiers: registry,
        hints: hint(a),
      }),
    ).rejects.toBeInstanceOf(PasskeyMismatchError)
    nothingAdopted(wallet)
    expect(await service.rootCredentialId()).toBeUndefined()
    expect(service.isUnlocked()).toBe(false)
  })

  it("a hint that names a key other than this browser's record for the credential is the same refusal", async () => {
    const { service, storage } = phone()
    const a = await service.createPasskey("@alice")
    // The record holds a different key than the one the passkey signs with.
    await new WebPasskeyIdentityMap(storage, "localhost").upsert({
      credentialId: a.credentialId,
      l2Address: ADDR,
      pubkey: "ab".repeat(64),
      isMskRoot: true,
    })
    const wallet = walletFor(a.secretKey)
    await expect(
      enterWithPasskey(wallet, config, "alice", {
        contractService: {} as never,
        gate: gateFor().gate,
        tiers: registry,
        hints: hint(a),
      }),
    ).rejects.toBeInstanceOf(PasskeyMismatchError)
    nothingAdopted(wallet)
    expect(service.isUnlocked()).toBe(false)
  })

  it("a closed sheet propagates as the browser's own error", async () => {
    const { service, ceremony } = phone()
    const a = await service.createPasskey("@alice")
    ceremony.opts.assertOverride = () => {
      throw new DOMException("Dismissed", "NotAllowedError")
    }
    const wallet = walletFor(a.secretKey)
    await expect(
      enterWithPasskey(wallet, config, "alice", {
        contractService: {} as never,
        gate: gateFor().gate,
        tiers: registry,
        hints: hint(a),
      }),
    ).rejects.toMatchObject({ name: "NotAllowedError" })
    nothingAdopted(wallet)
  })

  it("the service's other refusals keep their class, and a cancelled attempt reads as the cancel", async () => {
    const { service, ceremony } = phone()
    const a = await service.createPasskey("@alice")
    ceremony.opts.prfAtAssert = false
    await expect(
      enterWithPasskey(walletFor(a.secretKey), config, "alice", {
        contractService: {} as never,
        gate: gateFor().gate,
        tiers: registry,
        hints: hint(a),
      }),
    ).rejects.toMatchObject({ name: "NoPrfError" })
    ceremony.opts.prfAtAssert = true
    const { gate, controller } = gateFor()
    controller.abort()
    await expect(
      enterWithPasskey(walletFor(a.secretKey), config, "alice", {
        contractService: {} as never,
        gate,
        tiers: registry,
        hints: hint(a),
      }),
    ).rejects.toSatisfy(isGateCancelled)
  })

  it("only the selected tag names the claim: a remembered tag for the account is not consulted", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    h.readNameOf.mockResolvedValue(nameOf("bob"))
    remember(a, "bob")
    const result = await enterWithPasskey(walletFor(a.secretKey), config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a),
    })
    expect(result).toMatchObject({ entered: false, reason: "confirm" })
  })

  it("no anchor: unknown carries the answering credential and every derived address", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    const wallet = walletFor(a.secretKey)
    const result = await enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: [],
      hints: hint(a),
    })
    expect(result).toEqual({
      entered: false,
      reason: "unknown",
      credentialId: a.credentialId,
      pubkey: a.pubkey,
      addresses: expect.arrayContaining([ADDR, OTHER]),
      observed: expect.objectContaining({ credentialId: a.credentialId }),
      storedAddressMismatch: false,
    })
    if (result.entered || result.reason !== "unknown") throw new Error("unreachable")
    expect(result.addresses).toHaveLength(2)
    expect(diagnoseUnknown(result, ADDR)).toBe("REGISTRY_UNANCHORED")
    expect(diagnoseUnknown(result, ADDR.toUpperCase())).toBe("REGISTRY_UNANCHORED")
    expect(diagnoseUnknown(result, ELSEWHERE)).toBe("PASSKEY_KEY_MISMATCH")
    nothingAdopted(wallet)
    expect(service.isUnlocked()).toBe(false)
  })

  it("this browser's record for the credential no longer reproducing is the key mismatch, whatever derives", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    await record(service, a, ELSEWHERE)
    const wallet = walletFor(a.secretKey)
    const result = await enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a),
    })
    // A phone's own passkey answers as `platform` too; only a laptop's own copy is the certain
    // wrong key, so a phone stays the weaker not-reproduced.
    expect(result).toMatchObject({
      entered: false,
      reason: "unknown",
      credentialId: a.credentialId,
      storedAddressMismatch: true,
      verdict: "not-reproduced",
    })
    if (result.entered || result.reason !== "unknown") throw new Error("unreachable")
    expect(result.addresses).toContain(ADDR)
    expect(diagnoseUnknown(result, ADDR)).toBe("PASSKEY_KEY_MISMATCH")
    nothingAdopted(wallet)
  })

  it("a laptop's own copy returning the wrong key is the certain verdict", async () => {
    const { service } = laptop({ divergent: true })
    const a = await service.createPasskey("@alice")
    await record(service, a, ADDR)
    const wallet = walletFor(a.secretKey)
    // A laptop sign-in admits the local copy, so the browser answers with a `platform` attachment;
    // a bound-slot mismatch from it is the certain wrong key.
    const result = await enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a),
    })
    expect(result).toMatchObject({
      entered: false,
      reason: "unknown",
      storedAddressMismatch: true,
      verdict: "wrong-key",
      observed: { credentialId: a.credentialId, attachment: "platform" },
    })
    nothingAdopted(wallet)
  })

  it("with no record, a laptop's own copy returning the wrong key is still named, from the pin's own evidence", async () => {
    const { service } = laptop({ divergent: true })
    const a = await service.createPasskey("@alice")
    const wallet = walletFor(a.secretKey)
    const result = await enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a),
    })
    expect(result).toMatchObject({
      entered: false,
      reason: "unknown",
      observed: { credentialId: a.credentialId, attachment: "platform" },
    })
    if (result.entered || result.reason !== "unknown") throw new Error("unreachable")
    expect(result.storedAddressMismatch).toBe(false)
    // Both slots were evaluated and neither derived the account.
    expect(result.addresses).toHaveLength(2)
    expect(result.addresses).not.toContain(ADDR)
    const pinned = { laptop: true, moreKeys: false }
    expect(diagnoseUnknown(result, ADDR, pinned)).toBe("LOCAL_COPY_WRONG_KEY")
    // Another key on the account could be its root, so the same miss stays the plain mismatch.
    expect(diagnoseUnknown(result, ADDR, { laptop: true, moreKeys: true })).toBe(
      "PASSKEY_KEY_MISMATCH",
    )
    // A phone's own passkey answers as `platform` too; the wrong-key verdict is a laptop's alone.
    expect(diagnoseUnknown(result, ADDR, { laptop: false, moreKeys: false })).toBe(
      "PASSKEY_KEY_MISMATCH",
    )
    // Without the evidence, as the plain path calls it, nothing changes.
    expect(diagnoseUnknown(result, ADDR)).toBe("PASSKEY_KEY_MISMATCH")
    // A one-slot answer proves nothing about the other slot.
    expect(
      diagnoseUnknown({ ...result, addresses: [result.addresses![0]!] }, ADDR, pinned),
    ).toBe("PASSKEY_KEY_MISMATCH")
    // Another device's answer is that device's, not this computer's copy.
    expect(
      diagnoseUnknown(
        { ...result, observed: { credentialId: a.credentialId, attachment: "cross-platform" } },
        ADDR,
        pinned,
      ),
    ).toBe("PASSKEY_KEY_MISMATCH")
    nothingAdopted(wallet)
  })

  it("a cancel while the account is persisted after the commit hands nothing back, on any route", async () => {
    for (const named of [true, false]) {
      const { service } = phone()
      const a = await service.createPasskey("@alice")
      h.readNameOf.mockResolvedValue(named ? nameOf("alice") : `0x${"0".repeat(64)}`)
      const cancel = new AbortController()
      h.addWebauthnAccount.mockImplementationOnce(async () => cancel.abort())
      await expect(
        enterWithPasskey(walletFor(a.secretKey), config, "alice", {
          contractService: {} as never,
          gate: gateFor().gate,
          tiers: registry,
          hints: hint(a),
          signal: cancel.signal,
        }),
      ).rejects.toSatisfy(isGateCancelled)
      // The commit stood; the result that would have entered or resumed a signup did not.
      expect(service.isUnlocked()).toBe(true)
    }
  })

  it("a laptop sign-in another device answered (a cross-platform attachment) enters", async () => {
    const { service } = laptop({ assertAttachment: "cross-platform" })
    const a = await service.createPasskey("@alice")
    await record(service, a, ADDR)
    const result = await enterWithPasskey(walletFor(a.secretKey), config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a),
    })
    expect(result).toMatchObject({ entered: true, handle: "alice" })
  })

  it("an address derivation that fails keeps its own error, not the diagnosis", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    await record(service, a, ELSEWHERE)
    const wallet = walletFor(a.secretKey, {
      deriveAccountAddress: async () => {
        throw new Error("pxe down")
      },
    })
    await expect(
      enterWithPasskey(wallet, config, "alice", {
        contractService: {} as never,
        gate: gateFor().gate,
        tiers: registry,
        hints: hint(a),
      }),
    ).rejects.toThrow(/pxe down/)
  })

  it("a plain enter's unknown carries the answering credential and its evidence, no verdict", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const result = await enterWithPasskey(walletFor(a.secretKey), config, undefined, {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: [],
      chooser: true,
    })
    expect(result).toMatchObject({
      entered: false,
      reason: "unknown",
      credentialId: a.credentialId,
      pubkey: a.pubkey,
    })
    if (result.entered || result.reason !== "unknown") throw new Error("unreachable")
    // No record was mismatched, so there is no verdict — the tag path diagnoses it instead.
    expect(result.verdict).toBeUndefined()
    expect(result.observed).toBeDefined()
    expect(h.getCode).toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe("strictTag on the session's own key", () => {
  it("refuses the remembered tag and lands on confirm; the plain entry takes it", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    await committed(service, a)
    h.readNameOf.mockResolvedValue(nameOf("bob"))
    remember(a, "bob")
    const wallet = walletFor(a.secretKey)
    const strict = await enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      strictTag: true,
      signal: new AbortController().signal,
    })
    expect(strict).toMatchObject({ entered: false, reason: "confirm" })
    const plain = await enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
    })
    expect(plain).toMatchObject({ entered: true, handle: "bob" })
  })
})

describe("a cancel ends the hinted sign-in wherever it lands", () => {
  const LOCK = "webwallet.passkey-identity-map"

  it("before the gate: neither the gate nor the prompt starts", async () => {
    const { service, ceremony } = phone()
    const a = await service.createPasskey("@alice")
    const cache = deferred<undefined>()
    vi.spyOn(service, "recoverFromCache").mockReturnValueOnce(cache.promise)
    const cancel = new AbortController()
    const { gate } = gateFor()
    const wallet = walletFor(a.secretKey)
    const entering = enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate,
      tiers: registry,
      hints: hint(a),
      signal: cancel.signal,
    })
    await tick()
    cancel.abort()
    cache.resolve(undefined)
    await expect(entering).rejects.toSatisfy(isGateCancelled)
    expect(gate).not.toHaveBeenCalled()
    expect(ceremony.asserts).toEqual([])
    nothingAdopted(wallet)
  })

  it("during the anchor probe: nothing adopted, nothing stored", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    const probe = deferred<"anchored">()
    const probing = deferred<void>()
    const tier: AnchorTier[] = [
      {
        name: "registry",
        probes: [
          async () => {
            probing.resolve()
            return probe.promise
          },
        ],
      },
    ]
    const cancel = new AbortController()
    const wallet = walletFor(a.secretKey)
    const entering = enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: tier,
      hints: hint(a),
      signal: cancel.signal,
    })
    await probing.promise
    cancel.abort()
    probe.resolve("anchored")
    await expect(entering).rejects.toSatisfy(isGateCancelled)
    nothingAdopted(wallet)
    expect(await service.rootCredentialId()).toBeUndefined()
    expect(getActiveStorageId()).toBeNull()
  })

  it("during the name read: nothing adopted", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    const name = deferred<string>()
    h.readNameOf.mockImplementationOnce(() => name.promise)
    const cancel = new AbortController()
    const wallet = walletFor(a.secretKey)
    const entering = enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a),
      signal: cancel.signal,
    })
    await until(() => h.readNameOf.mock.calls.length === 1)
    cancel.abort()
    name.resolve(nameOf("alice"))
    await expect(entering).rejects.toSatisfy(isGateCancelled)
    nothingAdopted(wallet)
    expect(await service.rootCredentialId()).toBeUndefined()
  })

  it("while the account is being built: no record, no commit", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    const building = deferred<typeof account>()
    const createObsidionAccount = vi.fn(() => building.promise)
    const wallet = walletFor(a.secretKey, { createObsidionAccount })
    const cancel = new AbortController()
    const entering = enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a),
      signal: cancel.signal,
    })
    await until(() => createObsidionAccount.mock.calls.length === 1)
    cancel.abort()
    building.resolve(account)
    await expect(entering).rejects.toSatisfy(isGateCancelled)
    expect(await service.rootCredentialId()).toBeUndefined()
    expect(service.isUnlocked()).toBe(false)
    expect(h.addWebauthnAccount).not.toHaveBeenCalled()
  })

  it("while the record waits on the identity map's lock: no record written", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    const held = deferred<void>()
    const holding = withWebLock(LOCK, () => held.promise)
    const queued = deferred<void>()
    const upsert = WebPasskeyIdentityMap.prototype.upsert
    vi.spyOn(WebPasskeyIdentityMap.prototype, "upsert").mockImplementation(function (
      this: WebPasskeyIdentityMap,
      ...args
    ) {
      queued.resolve()
      return upsert.apply(this, args)
    })
    const cancel = new AbortController()
    const entering = enterWithPasskey(walletFor(a.secretKey), config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a),
      signal: cancel.signal,
    })
    await queued.promise
    cancel.abort()
    held.resolve()
    await holding
    await expect(entering).rejects.toSatisfy(isGateCancelled)
    expect(await service.rootCredentialId()).toBeUndefined()
    expect(service.isUnlocked()).toBe(false)
    expect(h.addWebauthnAccount).not.toHaveBeenCalled()
  })

  it("inside the commit: the record stays, the session does not move, nothing cached", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    const deriving = deferred<string>()
    h.storageIdFromSecret.mockImplementationOnce(() => deriving.promise)
    const cancel = new AbortController()
    const entering = enterWithPasskey(walletFor(a.secretKey), config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a),
      signal: cancel.signal,
    })
    await until(() => h.storageIdFromSecret.mock.calls.length === 1)
    cancel.abort()
    deriving.resolve("storage-id")
    await expect(entering).rejects.toSatisfy(isGateCancelled)
    expect(await service.rootCredentialId()).toBe(a.credentialId)
    expect(getActiveStorageId()).toBeNull()
    expect(getActiveCredentialId()).toBeNull()
    expect(readCachedMsk()).toBeNull()
    expect(service.isUnlocked()).toBe(false)
    expect(h.addWebauthnAccount).not.toHaveBeenCalled()
  })

  it("on the session's own key, with no gate attempt: the session stays as it was", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    await committed(service, a)
    const before = {
      storageId: getActiveStorageId(),
      credentialId: getActiveCredentialId(),
      cache: readCachedMsk(),
    }
    const name = deferred<string>()
    h.readNameOf.mockImplementationOnce(() => name.promise)
    const gate = vi.fn(async () => ({
      signal: new AbortController().signal,
      reach: "unknown" as const,
    }))
    const cancel = new AbortController()
    const wallet = walletFor(a.secretKey)
    const entering = enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate,
      tiers: registry,
      hints: hint(a),
      signal: cancel.signal,
    })
    await until(() => h.readNameOf.mock.calls.length === 1)
    cancel.abort()
    name.resolve(nameOf("alice"))
    await expect(entering).rejects.toSatisfy(isGateCancelled)
    expect(gate).not.toHaveBeenCalled()
    nothingAdopted(wallet)
    expect(getActiveStorageId()).toBe(before.storageId)
    expect(getActiveCredentialId()).toBe(before.credentialId)
    expect(readCachedMsk()).toEqual(before.cache)
  })

  it("the gate's attempt cancelled after the anchors ends the sign-in too", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    const name = deferred<string>()
    h.readNameOf.mockImplementationOnce(() => name.promise)
    const { gate, controller } = gateFor()
    const wallet = walletFor(a.secretKey)
    const entering = enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate,
      tiers: registry,
      hints: hint(a),
    })
    await until(() => h.readNameOf.mock.calls.length === 1)
    controller.abort()
    name.resolve(nameOf("alice"))
    await expect(entering).rejects.toSatisfy(isGateCancelled)
    nothingAdopted(wallet)
  })
})

describe("lookupPasskeyByTag", () => {
  const ACCOUNT = `0x${"44".repeat(20)}`
  const id = (fill: number) => Buffer.alloc(16, fill).toString("base64url")
  const key = (fill: number) => ({
    qx: `0x${fill.toString(16).padStart(2, "0").repeat(32)}`,
    qy: `0x${(fill + 1).toString(16).padStart(2, "0").repeat(32)}`,
  })
  const resolved = () =>
    h.resolveTagForCommit.mockResolvedValue({
      status: "resolved",
      account: ACCOUNT,
      l2Address: ADDR,
      rollupId: "1",
      sipaStealthPublicKey: { x: 1n, y: 2n },
      xmtpAddress: "0xeoa",
    })

  it("two keys on-chain: the first in order is the candidate, and more were there", async () => {
    resolved()
    h.readAuthKeysCounted.mockResolvedValue({
      entries: [
        { key: key(0x10), metadata: credentialIdToMetadata(id(1)) },
        { key: key(0x20), metadata: credentialIdToMetadata(id(2)) },
      ],
      authKeyCount: 2,
    })
    expect(await lookupPasskeyByTag("alice")).toEqual({
      kind: "resolved",
      tag: "alice",
      candidate: { credentialId: id(1), pubkeyHex: `${"10".repeat(32)}${"11".repeat(32)}` },
      l2Address: ADDR,
      moreKeys: true,
    })
    expect(h.resolveTagForCommit).toHaveBeenCalledWith("alice")
    expect(h.readAuthKeysCounted).toHaveBeenCalledWith(ACCOUNT, 8)
  })

  it("one key: no more keys", async () => {
    resolved()
    h.readAuthKeysCounted.mockResolvedValue({
      entries: [{ key: key(0x10), metadata: credentialIdToMetadata(id(1)) }],
      authKeyCount: 1,
    })
    expect(await lookupPasskeyByTag("alice")).toMatchObject({ kind: "resolved", moreKeys: false })
  })

  it("a second key with no credential id is still a second key", async () => {
    resolved()
    h.readAuthKeysCounted.mockResolvedValue({
      entries: [
        { key: key(0x10), metadata: credentialIdToMetadata(id(1)) },
        { key: key(0x20), metadata: "0x" },
      ],
      authKeyCount: 2,
    })
    expect(await lookupPasskeyByTag("alice")).toMatchObject({
      kind: "resolved",
      candidate: expect.objectContaining({ credentialId: id(1) }),
      moreKeys: true,
    })
  })

  it("the reader's non-answers pass through, and a read that cannot reach the chain throws", async () => {
    h.resolveTagForCommit.mockResolvedValue({ status: "notFound" })
    expect(await lookupPasskeyByTag("nobody")).toEqual({ kind: "notFound" })
    resolved()
    h.readAuthKeysCounted.mockResolvedValue({ entries: [], authKeyCount: 0 })
    expect(await lookupPasskeyByTag("alice")).toEqual({ kind: "noKeyInstalled", account: ACCOUNT })
    h.readAuthKeysCounted.mockRejectedValue(new Error("rpc down"))
    await expect(lookupPasskeyByTag("alice")).rejects.toThrow(/rpc down/)
  })
})

describe("diagnoseMiss", () => {
  const ACCOUNT = `0x${"55".repeat(20)}`
  const id = (fill: number) => Buffer.alloc(16, fill).toString("base64url")
  const key = (fill: number) => ({
    qx: `0x${fill.toString(16).padStart(2, "0").repeat(32)}`,
    qy: `0x${(fill + 1).toString(16).padStart(2, "0").repeat(32)}`,
  })
  const pubkeyOf = (fill: number) =>
    `${fill.toString(16).padStart(2, "0").repeat(32)}${(fill + 1)
      .toString(16)
      .padStart(2, "0")
      .repeat(32)}`
  const entry = (fill: number, credFill: number) => ({
    key: key(fill),
    metadata: credentialIdToMetadata(id(credFill)),
  })
  const resolve = () =>
    h.resolveTagForCommit.mockResolvedValue({
      status: "resolved",
      account: ACCOUNT,
      l2Address: ADDR,
      rollupId: "1",
      sipaStealthPublicKey: { x: 1n, y: 2n },
      xmtpAddress: "0xeoa",
    })
  const evidence = (
    over: Partial<{ credentialId: string; pubkey: string; addresses: string[] }> = {},
  ) => ({
    credentialId: id(1),
    pubkey: pubkeyOf(0x10),
    addresses: ["0xsomewhere"],
    ...over,
  })

  it("a matching entry whose account an address reproduces is a lagged registry probe", async () => {
    resolve()
    h.readAuthKeysCounted.mockResolvedValue({ entries: [entry(0x10, 1)], authKeyCount: 1 })
    expect(await diagnoseMiss(evidence({ addresses: [ADDR] }), "alice")).toBe("REGISTRY_UNANCHORED")
  })

  it("a matching entry that reproduces nothing is not-reproduced-here, never a divergence claim", async () => {
    resolve()
    h.readAuthKeysCounted.mockResolvedValue({ entries: [entry(0x10, 1)], authKeyCount: 1 })
    expect(await diagnoseMiss(evidence(), "alice")).toBe("NOT_REPRODUCED_HERE")
  })

  it("a credential absent from a complete set is a different passkey", async () => {
    resolve()
    h.readAuthKeysCounted.mockResolvedValue({ entries: [entry(0x20, 2)], authKeyCount: 1 })
    expect(await diagnoseMiss(evidence(), "alice")).toBe("DIFFERENT_PASSKEY")
  })

  it("an entry naming our credential but carrying another key is no match", async () => {
    resolve()
    // metadata is our credential id, but the key differs — id alone is not a match.
    h.readAuthKeysCounted.mockResolvedValue({ entries: [entry(0x20, 1)], authKeyCount: 1 })
    expect(await diagnoseMiss(evidence(), "alice")).toBe("DIFFERENT_PASSKEY")
  })

  it("a credential absent from an incomplete set is inconclusive, not a different passkey", async () => {
    resolve()
    // Eight read, nine installed: ours could be the ninth.
    const eight = Array.from({ length: 8 }, (_, i) => entry(0x30 + i, 20 + i))
    h.readAuthKeysCounted.mockResolvedValue({ entries: eight, authKeyCount: 9 })
    expect(await diagnoseMiss(evidence(), "alice")).toBe("INCONCLUSIVE")
  })

  it("eight ineligible entries hiding a later eligible one are inconclusive, not unreadable", async () => {
    resolve()
    const ineligible = Array.from({ length: 8 }, () => ({
      key: key(0x10),
      metadata: "0x" as const,
    }))
    h.readAuthKeysCounted.mockResolvedValue({ entries: ineligible, authKeyCount: 9 })
    expect(await diagnoseMiss(evidence(), "alice")).toBe("INCONCLUSIVE")
  })

  it("no eligible entry in a complete set is unreadable; an account holding no key has none installed", async () => {
    resolve()
    h.readAuthKeysCounted.mockResolvedValue({
      entries: [{ key: key(0x10), metadata: "0x" as const }],
      authKeyCount: 1,
    })
    expect(await diagnoseMiss(evidence(), "alice")).toBe("unreadable")
    h.readAuthKeysCounted.mockResolvedValue({ entries: [], authKeyCount: 0 })
    expect(await diagnoseMiss(evidence(), "alice")).toBe("noKeyInstalled")
  })

  it("added key B, original A removed, a fresh browser answering B stays not-reproduced-here", async () => {
    // The account now holds only B. B is what answered, and it derives nothing the account uses.
    resolve()
    h.readAuthKeysCounted.mockResolvedValue({ entries: [entry(0x10, 1)], authKeyCount: 1 })
    const out = await diagnoseMiss(evidence(), "alice")
    expect(out).toBe("NOT_REPRODUCED_HERE")
    // Never the strong record-anchored verdict — the chain marks no root.
    expect(out).not.toBe("WRONG_KEY_HERE")
  })

  it("the by-tag non-answers pass through", async () => {
    h.resolveTagForCommit.mockResolvedValue({ status: "notFound" })
    expect(await diagnoseMiss(evidence(), "nobody")).toBe("notFound")
    h.resolveTagForCommit.mockResolvedValue({ status: "staleRollup" })
    expect(await diagnoseMiss(evidence(), "alice")).toBe("staleRollup")
  })
})
