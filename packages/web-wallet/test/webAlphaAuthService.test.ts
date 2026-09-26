import { Fr } from "@aztec/aztec.js/fields"
// @vitest-environment node
import { StoredAddressMismatchError, selectRecoveredMsk } from "@obsidion/front-core"
import { deriveMskFromPrfOutput } from "@obsidion/sdk"
import { describe, expect, it, vi } from "vitest"
import {
  type DevicePosture,
  NoPrfError,
  type PasskeyAssertRequest,
  type PasskeyCeremony,
  type PasskeyRequestScope,
} from "@obsidion/passkey-web"
import { statusForAttempt } from "../src/platform/auth/passkeyAttemptScope"
import { WebAlphaAuthService, isUnsettled } from "../src/platform/auth/WebAlphaAuthService"
import type { HandoffMaterial } from "../src/platform/storage/handoffMaterial"
import {
  clearActiveStorage,
  getActiveCredentialId,
  getActiveStorageId,
  readCachedMsk,
  setActiveCredentialId,
  setActiveStorageId,
  storageIdFromSecret,
  writeCachedMsk,
} from "../src/platform/storage/activeStorage"
import {
  FakePasskeyCeremony,
  type FakeCeremonyOptions,
  MemoryStorage,
} from "./support/fakePasskeyCeremony"

type ServiceOptions = FakeCeremonyOptions & {
  posture?: DevicePosture
  misreportsCrossDevice?: boolean
}

function makeService({
  posture = "laptop",
  misreportsCrossDevice = false,
  ...fake
}: ServiceOptions = {}) {
  const ceremony = new FakePasskeyCeremony(fake)
  const storage = new MemoryStorage()
  const service = new WebAlphaAuthService({
    storage,
    rpId: "localhost",
    ceremony,
    posture: () => posture,
    misreportsCrossDevice: () => misreportsCrossDevice,
  })
  return { service, ceremony, storage }
}

/** A laptop whose ceremonies a phone answers over the cross-device route. */
const laptop = (opts: FakeCeremonyOptions = {}) =>
  makeService({ posture: "laptop", route: "cross-device", ...opts })
/** A phone using its own passkey. */
const phone = (opts: FakeCeremonyOptions = {}) =>
  makeService({ posture: "phone", route: "local", ...opts })

const msk = (bytes: Uint8Array) => deriveMskFromPrfOutput(bytes).toString()

/** Address derivation that recognises exactly one master key under exactly one signing key. */
const deriveFor =
  (expected: { secretKey: Fr; pubkey: string }, address: string) =>
  async (candidate: Fr, pubkeyHex: string) =>
    candidate.toString() === expected.secretKey.toString() && pubkeyHex === expected.pubkey
      ? address
      : "0xother"

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * `refuse` names the keys this store rejects writes for; everything else behaves normally. Entries
 * are own enumerable properties, as on a real `Storage`, so key scans see them.
 */
const stubLocalStorage = (refuse: () => readonly string[] = () => []) => {
  const store: Record<string, string> = {}
  Object.defineProperties(store, {
    getItem: { value: (k: string) => (Object.hasOwn(store, k) ? store[k] : null) },
    setItem: {
      value: (k: string, v: string) => {
        if (refuse().includes(k)) throw new Error("QuotaExceededError")
        store[k] = v
      },
    },
    removeItem: { value: (k: string) => void delete store[k] },
  })
  vi.stubGlobal("localStorage", store)
  return () => vi.unstubAllGlobals()
}

async function record(
  service: WebAlphaAuthService,
  created: Awaited<ReturnType<WebAlphaAuthService["createPasskey"]>>,
  l2Address: string,
) {
  await service.recordRecoveryMetadata({
    credentialId: created.credentialId,
    l2Address,
    pubkey: created.pubkey,
    prfSlot: created.prfSlot,
    isMskRoot: true,
    transports: created.transports,
  })
}

describe("WebAlphaAuthService transports", () => {
  it("a laptop sign-in sends no transport restriction, so the copy synced to it can answer", async () => {
    const { service, ceremony } = laptop({ transports: ["hybrid", "internal"] })
    const created = await service.createPasskey("@alice")
    await record(service, created, "0xabc")
    await service.recoverPasskey({ credentialId: created.credentialId })
    // The browser's own chooser decides which device answers; a restriction would hide the local copy.
    expect(ceremony.assertRequests.at(-1)!.transports).toBeUndefined()
  })

  it("a credential this browser never recorded is likewise unrestricted", async () => {
    const { service, ceremony } = laptop({ transports: ["hybrid", "internal"] })
    const created = await service.createPasskey("@alice")
    await service.recoverPasskey({ credentialId: created.credentialId })
    expect(ceremony.assertRequests[0]!.transports).toBeUndefined()
    // The pubkey-recovery assertion that follows is left unsteered on purpose.
    expect(ceremony.assertRequests.at(-1)!.transports).toBeUndefined()
  })
})

/** A YubiKey: answers from another device, over USB, and cannot be backed up. */
const KEY: FakeCeremonyOptions = {
  manager: "security-key",
  transports: ["usb"],
  backupEligible: false,
}
/** What a sign-in browser infers for a key: every physical route but `ble`. */
const PHYSICAL = ["usb", "nfc", "smart-card"]
const MAP_KEY = "obsidion_web_passkey_identity_map"

/** Another browser holding the same authenticators: a service over its own storage. */
const freshOver = (
  ceremony: PasskeyCeremony,
  storage: MemoryStorage = new MemoryStorage(),
  posture: DevicePosture = "laptop",
) => new WebAlphaAuthService({ storage, rpId: "localhost", ceremony, posture: () => posture })

const storedEntry = async (storage: MemoryStorage, credentialId: string) =>
  JSON.parse((await storage.getItem(MAP_KEY)) ?? '{"entries":{}}').entries[credentialId]

const signWith = (provider: { createAuthWit: (m: Fr) => Promise<unknown> }) =>
  provider.createAuthWit(Fr.random())

/** A ceremony that can be told to refuse the next assertion the way a browser does. */
function refusable(opts: FakeCeremonyOptions) {
  const inner = new FakePasskeyCeremony({ route: "cross-device", ...opts })
  const state = { refuse: false }
  const requests: PasskeyAssertRequest[] = []
  const ceremony: PasskeyCeremony = {
    create: (request) => inner.create(request),
    assert: async (request) => {
      requests.push(request)
      if (state.refuse)
        throw Object.assign(new Error("no authenticator"), { name: "NotAllowedError" })
      return inner.assert(request)
    },
  }
  return { ceremony, state, last: () => requests.at(-1)! }
}

/** Storage whose identity-map writes can be held or refused. */
class GatedStorage extends MemoryStorage {
  gate?: () => Promise<void>
  override async setItem(key: string, value: string) {
    if (key === MAP_KEY && this.gate) await this.gate()
    return super.setItem(key, value)
  }
}

describe("WebAlphaAuthService signing steering", () => {
  it("the browser that created a security key signs straight to it, on either posture", async () => {
    for (const make of [
      () => laptop(KEY),
      () => makeService({ posture: "phone", route: "cross-device", ...KEY }),
    ]) {
      const { service, ceremony } = make()
      const created = await service.createPasskey("@alice")
      await record(service, created, "0xacct")
      await signWith(created.authProvider)
      expect(ceremony.assertRequests.at(-1)!.transports).toEqual(["usb"])
    }
  })

  it("a browser that signed in with a key is steered in the same session; a recorded list wins", async () => {
    const { service, ceremony } = laptop(KEY)
    const created = await service.createPasskey("@alice")
    const fresh = freshOver(ceremony)
    const recovered = await fresh.recoverPasskey({
      credentialId: created.credentialId,
    })
    await signWith(recovered.authProvider)
    expect(ceremony.assertRequests.at(-1)!.transports).toEqual(PHYSICAL)

    await fresh.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xacct",
      pubkey: created.pubkey,
      isMskRoot: true,
      transports: ["usb"],
    })
    await signWith(recovered.authProvider)
    expect(ceremony.assertRequests.at(-1)!.transports).toEqual(["usb"])
  })

  it("a signature teaches the record, and a later instance is steered with no memo", async () => {
    const { service, ceremony } = laptop(KEY)
    const created = await service.createPasskey("@alice")
    const storage = new MemoryStorage()
    const fresh = freshOver(ceremony, storage)
    await fresh.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xacct",
      pubkey: created.pubkey,
      isMskRoot: true,
    })
    const passkey = { credentialId: created.credentialId, pubkeyHex: created.pubkey }
    await signWith(fresh.providerFor(passkey))
    expect(ceremony.assertRequests.at(-1)!).not.toHaveProperty("transports")
    await flush()
    expect((await storedEntry(storage, created.credentialId)).inferredTransports).toEqual(PHYSICAL)

    const later = freshOver(ceremony, storage)
    await signWith(later.providerFor(passkey))
    expect(ceremony.assertRequests.at(-1)!.transports).toEqual(PHYSICAL)
  })

  it("a synced passkey is never steered at signing", async () => {
    for (const transports of [["hybrid", "internal"], ["hybrid"]]) {
      const { service, ceremony } = laptop({ transports })
      const created = await service.createPasskey("@alice")
      await record(service, created, "0xacct")
      await signWith(created.authProvider)
      expect(ceremony.assertRequests.at(-1)!).not.toHaveProperty("transports")
    }
    const { service, ceremony } = laptop()
    const created = await service.createPasskey("@alice")
    await signWith(created.authProvider)
    expect(ceremony.assertRequests.at(-1)!).not.toHaveProperty("transports")
  })

  it("a synced creation list vetoes a fresh inference, from a signature or a sign-in", async () => {
    const { service, ceremony, storage } = laptop({ transports: ["hybrid"] })
    const created = await service.createPasskey("@alice")
    await record(service, created, "0xacct")
    await signWith(created.authProvider)
    expect(ceremony.assertRequests.at(-1)!).not.toHaveProperty("transports")

    // Answers shaped like a key's, as a provider from before the backup gate might give.
    ceremony.opts.backupEligible = false
    await signWith(created.authProvider)
    await flush()
    await signWith(created.authProvider)
    expect(ceremony.assertRequests.at(-1)!).not.toHaveProperty("transports")
    await service.recoverPasskey({ credentialId: created.credentialId })
    await flush()
    expect((await storedEntry(storage, created.credentialId)).inferredTransports).toBeUndefined()
  })

  it("a heal the store refuses never fails the signature; the memo still steers", async () => {
    const { service, ceremony } = laptop(KEY)
    const created = await service.createPasskey("@alice")
    const storage = new GatedStorage()
    const fresh = freshOver(ceremony, storage)
    await fresh.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xacct",
      pubkey: created.pubkey,
      isMskRoot: true,
    })
    storage.gate = () => Promise.reject(new Error("QuotaExceededError"))
    const provider = fresh.providerFor({
      credentialId: created.credentialId,
      pubkeyHex: created.pubkey,
    })
    await signWith(provider)
    await flush()
    expect((await storedEntry(storage, created.credentialId)).inferredTransports).toBeUndefined()
    await signWith(provider)
    expect(ceremony.assertRequests.at(-1)!.transports).toEqual(PHYSICAL)
  })

  it("a refused inference is dropped, the next attempt is unsteered, and a later answer teaches again", async () => {
    const { ceremony, state, last } = refusable(KEY)
    const created = await freshOver(ceremony).createPasskey("@alice")
    const storage = new MemoryStorage()
    const fresh = freshOver(ceremony, storage)
    await fresh.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xacct",
      pubkey: created.pubkey,
      isMskRoot: true,
    })
    const provider = fresh.providerFor({
      credentialId: created.credentialId,
      pubkeyHex: created.pubkey,
    })

    await signWith(provider)
    await flush()
    await signWith(provider)
    expect(last().transports).toEqual(PHYSICAL)

    state.refuse = true
    await expect(signWith(provider)).rejects.toMatchObject({ name: "NotAllowedError" })
    await flush()
    expect((await storedEntry(storage, created.credentialId)).inferredTransports).toBeUndefined()

    state.refuse = false
    await signWith(provider)
    expect(last()).not.toHaveProperty("transports")
    await flush()
    await signWith(provider)
    expect(last().transports).toEqual(PHYSICAL)
    expect((await storedEntry(storage, created.credentialId)).inferredTransports).toEqual(PHYSICAL)
  })

  it("a clear the store holds or refuses still leaves the next attempt unsteered", async () => {
    const { ceremony, state, last } = refusable(KEY)
    const created = await freshOver(ceremony).createPasskey("@alice")
    const passkey = { credentialId: created.credentialId, pubkeyHex: created.pubkey }

    // Refused: the clear never lands, so the stored inference outlives this session.
    const storage = new GatedStorage()
    const fresh = freshOver(ceremony, storage)
    await fresh.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xacct",
      pubkey: created.pubkey,
      isMskRoot: true,
    })
    const provider = fresh.providerFor(passkey)
    await signWith(provider)
    await flush()
    storage.gate = () => Promise.reject(new Error("QuotaExceededError"))
    state.refuse = true
    await expect(signWith(provider)).rejects.toMatchObject({ name: "NotAllowedError" })
    await flush()
    state.refuse = false
    await signWith(provider)
    expect(last()).not.toHaveProperty("transports")
    expect((await storedEntry(storage, created.credentialId)).inferredTransports).toEqual(PHYSICAL)
    // A later session steers on the stale inference once, then suppresses on its own refusal.
    storage.gate = undefined
    const later = freshOver(ceremony, storage)
    const laterProvider = later.providerFor(passkey)
    state.refuse = true
    await expect(signWith(laterProvider)).rejects.toMatchObject({ name: "NotAllowedError" })
    expect(last().transports).toEqual(PHYSICAL)
    state.refuse = false
    await signWith(laterProvider)
    expect(last()).not.toHaveProperty("transports")

    // Held: the attempt issued before the clear lands is already unsteered.
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const slow = new GatedStorage()
    const slowService = freshOver(ceremony, slow)
    await slowService.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xacct",
      pubkey: created.pubkey,
      isMskRoot: true,
    })
    const slowProvider = slowService.providerFor(passkey)
    await signWith(slowProvider)
    await flush()
    slow.gate = () => held
    state.refuse = true
    await expect(signWith(slowProvider)).rejects.toMatchObject({ name: "NotAllowedError" })
    expect(last().transports).toEqual(PHYSICAL)
    await expect(signWith(slowProvider)).rejects.toMatchObject({ name: "NotAllowedError" })
    expect(last()).not.toHaveProperty("transports")
    release()
    await flush()
    expect((await storedEntry(slow, created.credentialId)).inferredTransports).toBeUndefined()
    // An answer after the clear teaches again, in order behind it.
    state.refuse = false
    await signWith(slowProvider)
    await flush()
    expect((await storedEntry(slow, created.credentialId)).inferredTransports).toEqual(PHYSICAL)
  })
})

describe("WebAlphaAuthService learns transports from sign-in", () => {
  const recordWithout = (
    service: WebAlphaAuthService,
    created: Awaited<ReturnType<WebAlphaAuthService["createPasskey"]>>,
  ) =>
    service.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xacct",
      pubkey: created.pubkey,
      isMskRoot: true,
    })

  it("unlock heals a record without transports, and a signature after it is steered", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, ceremony, storage } = laptop(KEY)
      const created = await service.createPasskey("@alice")
      await recordWithout(service, created)
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      service.clear()
      await service.unlock(deriveFor(created, "0xacct"), {})
      await flush()
      expect((await storedEntry(storage, created.credentialId)).inferredTransports).toEqual(
        PHYSICAL,
      )
      await signWith(
        service.providerFor({ credentialId: created.credentialId, pubkeyHex: created.pubkey }),
      )
      expect(ceremony.assertRequests.at(-1)!.transports).toEqual(PHYSICAL)
    } finally {
      restore()
    }
  })

  it("a sign-in the PRF gate then refuses still teaches", async () => {
    const { service, ceremony, storage } = laptop(KEY)
    const created = await service.createPasskey("@alice")
    await recordWithout(service, created)
    ceremony.opts.prfAtAssert = false
    await expect(
      service.recoverPasskey({ credentialId: created.credentialId }),
    ).rejects.toBeInstanceOf(NoPrfError)
    await flush()
    expect((await storedEntry(storage, created.credentialId)).inferredTransports).toEqual(PHYSICAL)
  })

  it("a record written after a key sign-in on a fresh browser carries the inference", async () => {
    const { service, ceremony } = laptop(KEY)
    const created = await service.createPasskey("@alice")
    const storage = new MemoryStorage()
    const fresh = freshOver(ceremony, storage)
    await fresh.recoverPasskey({ credentialId: created.credentialId })
    await recordWithout(fresh, created)
    expect((await storedEntry(storage, created.credentialId)).inferredTransports).toEqual(PHYSICAL)
  })

  it("a record with a creation list never takes an inference", async () => {
    const { service, ceremony, storage } = laptop(KEY)
    const created = await service.createPasskey("@alice")
    await record(service, created, "0xacct")
    await service.recoverPasskey({ credentialId: created.credentialId })
    await recordWithout(service, created)
    const entry = await storedEntry(storage, created.credentialId)
    expect(entry.transports).toEqual(["usb"])
    expect(entry.inferredTransports).toBeUndefined()
    await signWith(created.authProvider)
    expect(ceremony.assertRequests.at(-1)!.transports).toEqual(["usb"])
  })

  it("a synced passkey leaves no inference behind", async () => {
    const { service, storage } = laptop()
    const created = await service.createPasskey("@alice")
    await recordWithout(service, created)
    await service.recoverPasskey({ credentialId: created.credentialId })
    expect((await storedEntry(storage, created.credentialId)).inferredTransports).toBeUndefined()
  })

  it("a heal the store refuses never fails the unlock; a refused record write still throws", async () => {
    const restore = stubLocalStorage()
    try {
      const ceremony = new FakePasskeyCeremony({ route: "cross-device", ...KEY })
      const storage = new GatedStorage()
      const service = freshOver(ceremony, storage)
      const created = await service.createPasskey("@alice")
      await recordWithout(service, created)
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      service.clear()
      storage.gate = () => Promise.reject(new Error("QuotaExceededError"))
      await service.unlock(deriveFor(created, "0xacct"), {})
      expect(service.isUnlocked()).toBe(true)
      expect((await storedEntry(storage, created.credentialId)).inferredTransports).toBeUndefined()
      await expect(recordWithout(service, created)).rejects.toThrow(/Quota/)
    } finally {
      restore()
    }
  })

  it("a clear still in flight does not lose what the unlock after it learns", async () => {
    const restore = stubLocalStorage()
    try {
      const { ceremony, state, last } = refusable(KEY)
      const storage = new GatedStorage()
      const service = freshOver(ceremony, storage)
      const created = await service.createPasskey("@alice")
      await recordWithout(service, created)
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      const passkey = { credentialId: created.credentialId, pubkeyHex: created.pubkey }
      const provider = service.providerFor(passkey)
      await signWith(provider)
      await flush()

      let release!: () => void
      const held = new Promise<void>((resolve) => (release = resolve))
      storage.gate = () => held
      state.refuse = true
      await expect(signWith(provider)).rejects.toMatchObject({ name: "NotAllowedError" })
      state.refuse = false
      service.clear()
      // The unlock completes while the clear still holds the map: its heal is queued, not awaited.
      await service.unlock(deriveFor(created, "0xacct"), {})
      expect(service.isUnlocked()).toBe(true)
      release()
      await flush()
      expect((await storedEntry(storage, created.credentialId)).inferredTransports).toEqual(
        PHYSICAL,
      )

      const later = freshOver(ceremony, storage)
      await signWith(later.providerFor(passkey))
      expect(last().transports).toEqual(PHYSICAL)
    } finally {
      restore()
    }
  })
})

describe("WebAlphaAuthService.createPasskey", () => {
  it("laptop: asks a phone for the passkey and binds the account to slot first", async () => {
    const { service, ceremony } = laptop()
    const result = await service.createPasskey("@alice")
    expect(result.secretKey.toString()).toBe(msk(ceremony.prfFor(result.credentialId, "first")))
    expect(result.prfSlot).toBe("first")
    expect(result.authenticatorType).toBe("platform")
    expect(result.pubkey).toHaveLength(128)
    const request = ceremony.creates[0]!
    expect(request.authenticatorAttachment).toBe("cross-platform")
    // No hint: the browser's own sheet offers the phone and the security key alike.
    expect(request.hints).toBeUndefined()
    expect(request.prfFirstSalt).toBeDefined()
    expect(request.prfSecondSalt).toBeDefined()
  })

  it("laptop: sends the route the user picked, so the browser opens on that device", async () => {
    const { service, ceremony } = laptop()
    await service.createPasskey("@alice", undefined, { route: "security-key" })
    expect(ceremony.creates[0]!.hints).toEqual(["security-key"])
  })

  it("phone: a picked route changes nothing — a phone's own two classes are fixed", async () => {
    const { service, ceremony } = phone()
    const result = await service.createPasskey("@alice", undefined, { route: "security-key" })
    expect(ceremony.creates[0]!.hints).toEqual(["client-device", "security-key"])
    expect(ceremony.creates[0]!.authenticatorAttachment).toBeUndefined()
    expect(result.prfSlot).toBe("second")
  })

  it("phone: uses its own passkey and binds the account to slot second", async () => {
    const { service, ceremony } = phone()
    const result = await service.createPasskey("@alice")
    expect(result.secretKey.toString()).toBe(msk(ceremony.prfFor(result.credentialId, "second")))
    expect(result.prfSlot).toBe("second")
    const request = ceremony.creates[0]!
    // No class demanded, so the sheet may offer a security key alongside the phone's own passkey.
    expect(request.authenticatorAttachment).toBeUndefined()
    expect(request.hints).toEqual(["client-device", "security-key"])
  })

  it("laptop: a passkey answered locally is refused before any further prompt", async () => {
    const { service, ceremony } = makeService({ posture: "laptop", route: "local" })
    await expect(service.createPasskey("@alice")).rejects.toMatchObject({
      name: "PhoneRequiredError",
    })
    expect(ceremony.assertRequests).toHaveLength(0)
  })

  it("phone: a passkey answered by another device is refused", async () => {
    const { service } = makeService({ posture: "phone", route: "cross-device" })
    await expect(service.createPasskey("@alice")).rejects.toMatchObject({
      name: "LocalPasskeyRequiredError",
    })
  })

  it("laptop: the chained assertion must come over the same route as creation", async () => {
    const { service } = laptop({ prfAtCreate: false, assertAttachment: "platform" })
    await expect(service.createPasskey("@alice")).rejects.toMatchObject({
      name: "PhoneRequiredError",
    })
  })

  it("phone: the chained assertion must come over the same route as creation", async () => {
    const { service } = phone({ prfAtCreate: false, assertAttachment: "cross-platform" })
    await expect(service.createPasskey("@alice")).rejects.toMatchObject({
      name: "LocalPasskeyRequiredError",
    })
  })

  it("refuses a device-bound passkey on either posture", async () => {
    await expect(
      laptop({ backupEligible: false }).service.createPasskey("@a"),
    ).rejects.toMatchObject({ name: "DeviceBoundPasskeyError" })
    await expect(
      phone({ backupEligible: false }).service.createPasskey("@a"),
    ).rejects.toMatchObject({
      name: "DeviceBoundPasskeyError",
    })
  })

  it("an unreadable backup flag after the chained assertion counts as device-bound", async () => {
    const { service, ceremony } = laptop({ createAuthData: false, backupEligible: "unknown" })
    await expect(service.createPasskey("@alice")).rejects.toMatchObject({
      name: "DeviceBoundPasskeyError",
    })
    // The flag was unreadable at create, so the chained assertion ran and was also unreadable.
    expect(ceremony.assertRequests).toHaveLength(1)
  })

  it("phone: a provider that evaluates one salt only is refused", async () => {
    const { service } = phone({ secondSlot: false })
    await expect(service.createPasskey("@alice")).rejects.toMatchObject({
      name: "SingleSaltProviderError",
    })
  })

  it("a create response without PRF or flags is replaced whole by one chained assertion", async () => {
    const { service, ceremony } = laptop({ prfAtCreate: false, createAuthData: false })
    const result = await service.createPasskey("@alice")
    expect(result.secretKey.toString()).toBe(msk(ceremony.prfFor(result.credentialId, "first")))
    expect(ceremony.assertRequests).toHaveLength(1)
    expect(ceremony.assertRequests[0]!.prfSecondSalt).toBeDefined()
  })

  it("every witness after creation is its own assertion, sending no salts", async () => {
    const { service, ceremony } = laptop({ prfAtCreate: false, extensionBytes: 10 })
    const result = await service.createPasskey("@alice")
    expect(ceremony.assertRequests).toHaveLength(1)
    const hash = Fr.random()
    await result.authProvider.createAuthWit(hash)
    await result.authProvider.createAuthWit(hash)
    // One assertion for the chain, then one per witness. A witness assertion sends no salts, so it
    // carries nothing past the authenticator-data header the account contract reconstructs.
    expect(ceremony.assertRequests).toHaveLength(3)
    for (const fresh of ceremony.assertRequests.slice(1)) {
      expect(fresh.prfFirstSalt).toBeUndefined()
      expect(fresh.prfSecondSalt).toBeUndefined()
    }
  })

  it("refuses to serialize a signature the witness cannot carry, rather than truncating it", async () => {
    // Every assertion this authenticator gives back carries extension bytes, so no fresh one can
    // rescue the witness either. A truncated witness would fail on chain with nothing to explain it.
    const { service } = laptop({ extensionBytes: 10, extensionsAlways: true })
    const result = await service.createPasskey("@alice")
    await expect(result.authProvider.createAuthWit(Fr.random())).rejects.toThrow(/witness carries/)
  })

  it("no PRF from create nor the chained assertion is a hard stop, and the next attempt is fresh", async () => {
    const { service, ceremony } = laptop({ prfAtCreate: false, prfAtAssert: false })
    await expect(service.createPasskey("@alice")).rejects.toMatchObject({ name: "NoPrfError" })
    await expect(service.createPasskey("@alice")).rejects.toMatchObject({ name: "NoPrfError" })
    expect(ceremony.creates).toHaveLength(2)
    expect(await service.getSecretKey()).toBeUndefined()
  })

  it("createPasskey after commitSecret derives a fresh MSK and leaves the committed one untouched", async () => {
    const { service, ceremony } = laptop()
    const first = await service.createPasskey("@alice")
    await service.commitSecret({ secretKey: first.secretKey, authProvider: first.authProvider })
    const second = await service.createPasskey("@alice")
    expect(second.credentialId).not.toBe(first.credentialId)
    expect(second.secretKey.toString()).toBe(msk(ceremony.prfFor(second.credentialId, "first")))
    expect((await service.getSecretKey())?.toString()).toBe(first.secretKey.toString())
    expect(await service.getAuthProvider()).toBe(first.authProvider)
  })
})

describe("WebAlphaAuthService on a browser that mislabels a cross-device answer", () => {
  const ICLOUD = "fbfc3007-154e-4ecc-8c0b-6e020557d7bd"
  /** iCloud Keychain on the phone, reached over QR, labelled as the laptop's own. */
  const mislabelled = (opts: ServiceOptions = {}) =>
    makeService({
      posture: "laptop",
      route: "cross-device",
      manager: "icloud",
      aaguid: ICLOUD,
      transports: ["hybrid", "internal"],
      attachment: "platform",
      misreportsCrossDevice: true,
      ...opts,
    })

  it("reads the live user agent when the option is omitted", async () => {
    const safari18 =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15"
    const chrome =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    const live = (userAgent: string) => {
      vi.stubGlobal("navigator", { userAgent })
      const ceremony = new FakePasskeyCeremony({
        route: "cross-device",
        manager: "icloud",
        aaguid: ICLOUD,
        transports: ["hybrid", "internal"],
        attachment: "platform",
      })
      const service = new WebAlphaAuthService({
        storage: new MemoryStorage(),
        rpId: "localhost",
        ceremony,
        posture: () => "laptop",
      })
      return service.createPasskey("@alice")
    }
    try {
      expect((await live(safari18)).prfSlot).toBe("first")
      await expect(live(chrome)).rejects.toMatchObject({ name: "PhoneRequiredError" })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("creates from the mislabelled answer and binds slot first", async () => {
    const { service, ceremony } = mislabelled()
    const result = await service.createPasskey("@alice")
    expect(result.prfSlot).toBe("first")
    expect(result.prfAaguid).toBe(ICLOUD)
    expect(result.secretKey.toString()).toBe(msk(ceremony.prfFor(result.credentialId, "first")))
    expect(ceremony.assertRequests).toHaveLength(0)
  })

  it("refuses the same answer when the browser is not said to mislabel", async () => {
    const { service } = mislabelled({ misreportsCrossDevice: false })
    await expect(service.createPasskey("@alice")).rejects.toMatchObject({
      name: "PhoneRequiredError",
    })
  })

  it("refuses a corrected creation that lacks key material, with no follow-up prompt", async () => {
    const { service, ceremony } = mislabelled({ prfAtCreate: false })
    await expect(service.createPasskey("@alice")).rejects.toMatchObject({
      name: "IncompleteCreationError",
    })
    expect(ceremony.assertRequests).toHaveLength(0)
  })

  it("sign-in returns both candidates from a mislabelled answer, and the settle prompt is still unchecked", async () => {
    const { service, ceremony } = mislabelled({ attachment: "cross-platform" })
    const created = await service.createPasskey("@alice")
    ceremony.opts.attachment = "platform"
    const fresh = new WebAlphaAuthService({
      storage: new MemoryStorage(),
      rpId: "localhost",
      ceremony,
      posture: () => "laptop",
      misreportsCrossDevice: () => true,
    })
    ceremony.assertRequests = []
    const begun = await fresh.beginRecovery({})
    if (!isUnsettled(begun)) throw new Error("expected an unsettled recovery")
    expect(begun.candidates.first?.toString()).toBe(created.secretKey.toString())
    expect(begun.candidates.second).toBeDefined()
    const settled = await begun.settle()
    expect(settled.pubkey).toBe(created.pubkey)
    expect(ceremony.assertRequests).toHaveLength(2)
  })

  it("sign-in takes a platform label at face value when the browser is not said to mislabel", async () => {
    const { service, ceremony } = mislabelled({ attachment: "cross-platform" })
    await service.createPasskey("@alice")
    ceremony.opts.attachment = "platform"
    const fresh = new WebAlphaAuthService({
      storage: new MemoryStorage(),
      rpId: "localhost",
      ceremony,
      posture: () => "laptop",
      misreportsCrossDevice: () => false,
    })
    // No correction is applied, and a laptop sign-in admits its own copy, so the answer stands as
    // the browser labelled it.
    const begun = await fresh.beginRecovery({})
    expect(begun.observed?.attachment).toBe("platform")
  })
})

describe("WebAlphaAuthService.recoverPasskey", () => {
  it("returns both candidates and surfaces the persisted record", async () => {
    const { service, ceremony } = laptop()
    const created = await service.createPasskey("@alice")
    await record(service, created, "0xabc")
    service.clear()

    const recovered = await service.recoverPasskey({
      credentialId: created.credentialId,
    })
    expect(recovered.candidates.first?.toString()).toBe(created.secretKey.toString())
    expect(recovered.candidates.second?.toString()).toBe(
      msk(ceremony.prfFor(created.credentialId, "second")),
    )
    expect(recovered.expectedAddress).toBe("0xabc")
    expect(recovered.preferredSlot).toBe("first")
    expect(recovered.hasPersistedSlot).toBe(true)
    expect(recovered.pubkey).toBe(created.pubkey)
    expect(recovered.candidateSource).toBe("webauthn")
    expect(recovered.authenticatorType).toBe("platform")
    const request = ceremony.assertRequests.at(-1)!
    expect(request.prfFirstSalt).toBeDefined()
    expect(request.prfSecondSalt).toBeDefined()
    // A laptop sign-in admits its own copy: the sheet is steered to this device, and no security
    // key is named for a synced passkey, so a manager's extension may answer.
    expect(request.hints).toEqual(["client-device"])
  })

  it("laptop: a locally answered assertion is admitted, and the recovery alone commits nothing", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, ceremony } = laptop()
      const created = await service.createPasskey("@alice")
      await record(service, created, "0xabc")
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      service.clear()
      ceremony.opts.route = "local"
      const recovered = await service.recoverPasskey({ credentialId: created.credentialId })
      expect(recovered.observed?.attachment).toBe("platform")
      expect(recovered.expectedAddress).toBe("0xabc")
      // Nothing moves until the caller anchors and commits the candidate.
      expect(await service.getSecretKey()).toBeUndefined()
      expect(getActiveCredentialId()).toBe(created.credentialId)
    } finally {
      restore()
    }
  })

  it("phone: its own passkey is accepted and no hint is sent", async () => {
    const { service, ceremony } = phone()
    const created = await service.createPasskey("@alice")
    await record(service, created, "0xabc")
    service.clear()
    const recovered = await service.recoverPasskey({
      credentialId: created.credentialId,
    })
    expect(recovered.candidates.second?.toString()).toBe(created.secretKey.toString())
    expect(recovered.preferredSlot).toBe("second")
    expect(ceremony.assertRequests.at(-1)!.hints).toBeUndefined()
  })

  it("refuses a device-bound passkey at recovery on the device that holds it", async () => {
    const { service, ceremony } = phone()
    const created = await service.createPasskey("@alice")
    await record(service, created, "0xabc")
    ceremony.opts.backupEligible = false
    await expect(
      service.recoverPasskey({ credentialId: created.credentialId }),
    ).rejects.toMatchObject({
      name: "DeviceBoundPasskeyError",
    })
  })

  it("creates and opens a wallet on a key that reports no backup from the first ceremony", async () => {
    // A real key reports no backup at creation too, and usually returns its key material only on
    // the chained assertion; both are set here so the whole path runs as it would in the field.
    const { service } = laptop({
      manager: "security-key",
      transports: ["usb"],
      backupEligible: false,
      prfAtCreate: false,
    })
    const restore = stubLocalStorage()
    try {
      const created = await service.createPasskey("@alice")
      expect(created.prfSlot).toBe("first")
      await record(service, created, "0xabc")
      const recovered = await service.recoverPasskey({
        credentialId: created.credentialId,
      })
      expect(recovered.candidates.first?.toString()).toBe(created.secretKey.toString())

      // "Opens" has to mean the anchored unlock commits it, not just that candidates came back.
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      service.clear()
      await service.unlock(deriveFor(created, "0xabc"), {})
      expect((await service.getSecretKey())?.toString()).toBe(created.secretKey.toString())
    } finally {
      restore()
    }
  })

  it("fails closed on a rotated (non-MSK-root) credential", async () => {
    const { service } = laptop()
    const created = await service.createPasskey("@alice")
    await service.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xabc",
      pubkey: created.pubkey,
      isMskRoot: false,
    })
    await expect(
      service.recoverPasskey({ credentialId: created.credentialId }),
    ).rejects.toMatchObject({
      name: "RotatedCredentialError",
    })
  })

  it("fresh browser (no record): two assertions recover the key, both candidates come back", async () => {
    const { service, ceremony } = laptop()
    const created = await service.createPasskey("@alice")
    // New service over EMPTY storage — same ceremony (the "synced credential").
    const fresh = new WebAlphaAuthService({
      storage: new MemoryStorage(),
      rpId: "localhost",
      ceremony,
      posture: () => "laptop",
    })
    ceremony.assertRequests = []
    const recovered = await fresh.recoverPasskey({})
    expect(ceremony.assertRequests).toHaveLength(2)
    expect(recovered.pubkey).toBe(created.pubkey)
    expect(recovered.candidates.first?.toString()).toBe(created.secretKey.toString())
    expect(recovered.candidates.second).toBeDefined()
    expect(recovered.expectedAddress).toBeUndefined()
    expect(recovered.preferredSlot).toBe("first")
  })

  it("fresh browser on a phone prefers the slot the local route implies", async () => {
    const { ceremony } = phone()
    const owner = new WebAlphaAuthService({
      storage: new MemoryStorage(),
      rpId: "localhost",
      ceremony,
      posture: () => "phone",
    })
    await owner.createPasskey("@alice")
    const fresh = new WebAlphaAuthService({
      storage: new MemoryStorage(),
      rpId: "localhost",
      ceremony,
      posture: () => "phone",
    })
    expect((await fresh.recoverPasskey()).preferredSlot).toBe("second")
  })
})

describe("WebAlphaAuthService.beginRecovery", () => {
  /** A browser with no record, over the same authenticator the passkey was created on. */
  async function freshBrowser(opts: FakeCeremonyOptions = {}) {
    const { service, ceremony } = laptop(opts)
    const created = await service.createPasskey("@alice")
    const fresh = new WebAlphaAuthService({
      storage: new MemoryStorage(),
      rpId: "localhost",
      ceremony,
      posture: () => "laptop",
    })
    ceremony.assertRequests = []
    ceremony.asserts = []
    return { fresh, ceremony, created }
  }

  it("fresh browser: one assertion over a one-time challenge, both keys and both master keys", async () => {
    const { fresh, ceremony, created } = await freshBrowser()
    const begun = await fresh.beginRecovery({})
    expect(ceremony.assertRequests).toHaveLength(1)
    if (!isUnsettled(begun)) throw new Error("expected an unsettled recovery")
    expect(begun.pubkeyCandidates).toContain(created.pubkey)
    expect(begun.pubkeyCandidates).toHaveLength(2)
    expect(begun.credentialId).toBe(created.credentialId)
    expect(begun.candidates.first?.toString()).toBe(created.secretKey.toString())
    expect(begun.candidates.second).toBeDefined()
    expect(begun.expectedAddress).toBeUndefined()
    expect(begun.preferredSlot).toBe("first")
  })

  it("settle(key): no further assertion, and a witness then costs one", async () => {
    const { fresh, ceremony, created } = await freshBrowser()
    const begun = await fresh.beginRecovery({})
    if (!isUnsettled(begun)) throw new Error("expected an unsettled recovery")
    const settled = await begun.settle(created.pubkey)
    expect(settled.pubkey).toBe(created.pubkey)
    expect(ceremony.assertRequests).toHaveLength(1)
    await settled.authProvider.createAuthWit(Fr.random())
    expect(ceremony.assertRequests).toHaveLength(2)
  })

  it("settle(): a second assertion over another random challenge recovers the shared key", async () => {
    const { fresh, ceremony, created } = await freshBrowser()
    const begun = await fresh.beginRecovery({})
    if (!isUnsettled(begun)) throw new Error("expected an unsettled recovery")
    const settled = await begun.settle()
    expect(settled.pubkey).toBe(created.pubkey)
    expect(ceremony.assertRequests).toHaveLength(2)
    const firstAsk = ceremony.assertRequests[0]!
    const second = ceremony.assertRequests[1]!
    expect(second.credentialIds).toEqual([created.credentialId])
    expect(second.prfFirstSalt).toBeUndefined()
    expect(second.prfSecondSalt).toBeUndefined()
    // Two different messages: only the key that signed both is recovered by both.
    expect(Buffer.from(second.challenge).equals(Buffer.from(firstAsk.challenge))).toBe(false)
    // Nothing is held from either assertion: a witness is a third prompt.
    await settled.authProvider.createAuthWit(Fr.random())
    expect(ceremony.assertRequests).toHaveLength(3)
  })

  it("beginRecovery hands the attempt to its assertion, and a cancelled one asks nothing", async () => {
    const { fresh, ceremony } = await freshBrowser()
    const live = new AbortController()
    await fresh.beginRecovery({ discover: true, signal: live.signal })
    expect(ceremony.assertRequests[0]!.signal).toBe(live.signal)

    const cancelled = new AbortController()
    cancelled.abort()
    await expect(fresh.beginRecovery({ signal: cancelled.signal })).rejects.toThrow(
      /abort/i,
    )
    expect(ceremony.assertRequests).toHaveLength(1)
  })

  it("settle() hands the attempt to the second assertion, and a cancelled one asks nothing", async () => {
    const { fresh, ceremony } = await freshBrowser()
    const begun = await fresh.beginRecovery({})
    if (!isUnsettled(begun)) throw new Error("expected an unsettled recovery")
    const live = new AbortController()
    await begun.settle(undefined, live.signal)
    expect(ceremony.assertRequests[1]!.signal).toBe(live.signal)

    const cancelled = new AbortController()
    cancelled.abort()
    await expect(begun.settle(undefined, cancelled.signal)).rejects.toThrow(/abort/i)
    expect(ceremony.assertRequests).toHaveLength(2)
  })

  it("settle(key) refuses a key the signature does not recover to, without a prompt", async () => {
    const { fresh, ceremony } = await freshBrowser()
    const begun = await fresh.beginRecovery({})
    if (!isUnsettled(begun)) throw new Error("expected an unsettled recovery")
    const other = await laptop().service.createPasskey("@bob")
    await expect(begun.settle(other.pubkey)).rejects.toThrow(/not a candidate/)
    expect(ceremony.assertRequests).toHaveLength(1)
  })

  it("a wrong candidate never signs, even for an authenticator that repeats signatures", async () => {
    const { fresh, ceremony, created } = await freshBrowser({ stableAuthenticator: true })
    const begun = await fresh.beginRecovery({})
    if (!isUnsettled(begun)) throw new Error("expected an unsettled recovery")
    const wrong = begun.pubkeyCandidates.find((k) => k !== created.pubkey)!
    const settled = await begun.settle(wrong)
    expect(settled.pubkey).toBe(wrong)
    for (let i = 0; i < 2; i++) {
      await expect(settled.authProvider.createAuthWit(Fr.random())).rejects.toMatchObject({
        name: "SignerKeyMismatchError",
      })
    }
    // Each attempt asked the passkey and got the same signature back; neither passed the check.
    expect(ceremony.assertRequests).toHaveLength(3)
  })

  it("a wrong recorded key is refused at recovery after a reload", async () => {
    const { fresh, ceremony, created } = await freshBrowser({ stableAuthenticator: true })
    const begun = await fresh.beginRecovery({})
    if (!isUnsettled(begun)) throw new Error("expected an unsettled recovery")
    // The other candidate of one signature is no candidate of the next, so the record cannot be
    // this credential's.
    const wrong = begun.pubkeyCandidates.find((k) => k !== created.pubkey)!
    await fresh.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xabc",
      pubkey: wrong,
      prfSlot: "first",
      isMskRoot: true,
    })
    fresh.clear()
    ceremony.assertRequests = []

    await expect(
      fresh.recoverPasskey({ credentialId: created.credentialId }),
    ).rejects.toMatchObject({
      name: "RotatedCredentialError",
    })
    expect(ceremony.assertRequests).toHaveLength(1)
  })

  it("a record known before asserting settles at once from the record, over one assertion", async () => {
    const { service, ceremony } = laptop()
    const created = await service.createPasskey("@alice")
    await record(service, created, "0xabc")
    service.clear()
    ceremony.assertRequests = []
    const begun = await service.beginRecovery({
      credentialId: created.credentialId,
    })
    expect(isUnsettled(begun)).toBe(false)
    if (isUnsettled(begun)) throw new Error("unreachable")
    expect(begun.pubkey).toBe(created.pubkey)
    expect(ceremony.assertRequests).toHaveLength(1)
  })

  it("the chooser returning a recorded credential settles from the record, and a witness costs a prompt", async () => {
    const { service, ceremony } = laptop()
    const created = await service.createPasskey("@alice")
    await record(service, created, "0xabc")
    service.clear()
    ceremony.assertRequests = []
    const begun = await service.beginRecovery({ discover: true })
    expect(isUnsettled(begun)).toBe(false)
    expect(ceremony.assertRequests).toHaveLength(1)
    if (isUnsettled(begun)) throw new Error("unreachable")
    expect(begun.pubkey).toBe(created.pubkey)
    await begun.authProvider.createAuthWit(Fr.random())
    expect(ceremony.assertRequests).toHaveLength(2)
  })

  it("the recorded passkey asked for, another answering: refused before anything is held", async () => {
    const { service, ceremony } = laptop()
    const created = await service.createPasskey("@alice")
    await record(service, created, "0xabc")
    service.clear()
    const other = await ceremony.create({
      rpId: "localhost",
      rpName: "test",
      userName: "@bob",
      prfFirstSalt: new Uint8Array(32),
    })
    const answer = ceremony.assert.bind(ceremony)
    ceremony.assert = (request) => answer({ ...request, credentialIds: [other.credentialId] })
    await expect(
      service.beginRecovery({ credentialId: created.credentialId }),
    ).rejects.toThrow(/not the one this browser asked for/)
  })

  it("a rotated credential is refused before anything unsettled exists", async () => {
    const { service, created } = await (async () => {
      const l = laptop()
      const c = await l.service.createPasskey("@alice")
      return { ...l, created: c }
    })()
    await service.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xabc",
      pubkey: created.pubkey,
      isMskRoot: false,
    })
    await expect(
      service.beginRecovery({ credentialId: created.credentialId }),
    ).rejects.toMatchObject({
      name: "RotatedCredentialError",
    })
  })
})

describe("WebAlphaAuthService.unlock", () => {
  it("commits the candidate whose address matches this browser's record, on either slot", async () => {
    const restore = stubLocalStorage()
    try {
      for (const make of [laptop, phone]) {
        const { service } = make()
        const created = await service.createPasskey("@alice")
        await record(service, created, "0xacct")
        await service.commitSecret({
          secretKey: created.secretKey,
          authProvider: created.authProvider,
        })
        service.clear()
        await service.unlock(deriveFor(created, "0xacct"), {})
        expect((await service.getSecretKey())?.toString()).toBe(created.secretKey.toString())
      }
    } finally {
      restore()
    }
  })

  it("derives every candidate under the record's signing key", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = laptop()
      const created = await service.createPasskey("@alice")
      await record(service, created, "0xacct")
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      service.clear()
      const derive = vi.fn(deriveFor(created, "0xacct"))
      await service.unlock(derive, {})
      expect(derive).toHaveBeenCalled()
      for (const [, pubkeyHex] of derive.mock.calls) expect(pubkeyHex).toBe(created.pubkey)
    } finally {
      restore()
    }
  })

  it("a record naming a key the passkey cannot have signed with is refused", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = laptop()
      const created = await service.createPasskey("@alice")
      await service.recordRecoveryMetadata({
        credentialId: created.credentialId,
        l2Address: "0xacct",
        pubkey: "ff".repeat(64),
        prfSlot: created.prfSlot,
        isMskRoot: true,
      })
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      service.clear()
      await expect(
        service.unlock(deriveFor(created, "0xacct"), {}),
      ).rejects.toMatchObject({
        name: "RotatedCredentialError",
      })
      expect(await service.getSecretKey()).toBeUndefined()
    } finally {
      restore()
    }
  })

  it("refuses when neither candidate derives the recorded address", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = laptop()
      const created = await service.createPasskey("@alice")
      await record(service, created, "0xacct")
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      service.clear()
      await expect(service.unlock(async () => "0xnever", {})).rejects.toThrow(
        /does not match/,
      )
      expect(await service.getSecretKey()).toBeUndefined()
    } finally {
      restore()
    }
  })

  it("a passkey that cannot be backed up and matches no record opens nothing", async () => {
    const restore = stubLocalStorage()
    try {
      // At sign-in another device's answer is exempt from the backup gate, so the anchor is the
      // only thing standing between it and a committed key. It has to be enough.
      const { service, ceremony } = laptop()
      const created = await service.createPasskey("@alice")
      await record(service, created, "0xacct")
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      service.clear()
      ceremony.opts.backupEligible = false
      await expect(service.unlock(async () => "0xnever", {})).rejects.toThrow(
        /does not match/,
      )
      expect(await service.getSecretKey()).toBeUndefined()
      expect(service.isUnlocked()).toBe(false)
    } finally {
      restore()
    }
  })

  it("an active credential with no record goes to /enter, not to a ceremony", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, ceremony } = laptop()
      setActiveCredentialId("unknown-credential")
      await expect(service.unlock(async () => "0x", {})).rejects.toThrow(
        /enter with your passkey/,
      )
      expect(ceremony.assertRequests).toHaveLength(0)
    } finally {
      restore()
    }
  })

  it("never falls back to the newest root when the active credential is missing", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, ceremony } = laptop()
      const a = await service.createPasskey("@alice")
      await record(service, a, "0xa")
      const b = await service.createPasskey("@bob")
      await record(service, b, "0xb")
      setActiveStorageId("storage-of-a")
      await expect(service.unlock(async () => "0xb", {})).rejects.toThrow(
        /enter with your passkey/,
      )
      expect(ceremony.assertRequests).toHaveLength(0)
      expect(getActiveStorageId()).toBe("storage-of-a")
      expect(await service.getSecretKey()).toBeUndefined()
    } finally {
      restore()
    }
  })

  it("concurrent unlock() calls share one passkey ceremony", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, ceremony } = laptop()
      const created = await service.createPasskey("@alice")
      await record(service, created, "0xacct")
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      service.clear()
      const derive = deriveFor(created, "0xacct")
      const asserts = vi.spyOn(ceremony, "assert")
      await Promise.all([
        service.unlock(derive, {}),
        service.unlock(derive, {}),
        service.unlock(derive, {}),
      ])
      expect(asserts).toHaveBeenCalledTimes(1)
      expect((await service.getSecretKey())?.toString()).toBe(created.secretKey.toString())

      // The shared promise is released, so a later lock can unlock again.
      service.clear()
      await service.unlock(derive, {})
      expect(asserts).toHaveBeenCalledTimes(2)
    } finally {
      restore()
    }
  })

  it("a prompt that outlives a commit in this tab leaves the newer key in place", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, ceremony } = laptop()
      const a = await service.createPasskey("@alice")
      await record(service, a, "0xa")
      await service.commitSecret({ secretKey: a.secretKey, authProvider: a.authProvider })
      service.clear()
      const assert = ceremony.assert.bind(ceremony)
      let release!: () => void
      vi.spyOn(ceremony, "assert").mockImplementationOnce(async (request) => {
        await new Promise<void>((resolve) => (release = resolve))
        return assert(request)
      })
      const pending = service.unlock(deriveFor(a, "0xa"), {})
      await flush()
      const b = await service.createPasskey("@bob")
      await record(service, b, "0xb")
      await service.commitSecret({ secretKey: b.secretKey, authProvider: b.authProvider })
      release()
      await expect(pending).rejects.toMatchObject({ name: "SessionChangedError" })
      expect((await service.getSecretKey())?.toString()).toBe(b.secretKey.toString())
      expect(readCachedMsk()?.credentialId).toBe(b.credentialId)
    } finally {
      restore()
    }
  })

  it("unlocks the session's passkey, not the newest root on the device", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = laptop()
      const a = await service.createPasskey("@alice")
      await record(service, a, "0xa")
      await service.commitSecret({ secretKey: a.secretKey, authProvider: a.authProvider })
      expect(getActiveCredentialId()).toBe(a.credentialId)

      service.clear()
      const b = await service.createPasskey("@bob")
      await record(service, b, "0xb")
      // Bob is now the newest root on the device, but Alice's session is the active one.
      setActiveCredentialId(a.credentialId)
      service.clear()
      await service.unlock(deriveFor(a, "0xa"), {})
      expect((await service.getSecretKey())?.toString()).toBe(a.secretKey.toString())
    } finally {
      restore()
    }
  })

  it("a failed recovery never moves the session passkey", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = laptop()
      const a = await service.createPasskey("@alice")
      await service.commitSecret({ secretKey: a.secretKey, authProvider: a.authProvider })
      service.clear()
      const second = await service.createPasskey("@alice")
      await service.recordRecoveryMetadata({
        credentialId: second.credentialId,
        l2Address: "0xa",
        pubkey: second.pubkey,
        isMskRoot: false,
      })
      await expect(
        service.recoverPasskey({ credentialId: second.credentialId }),
      ).rejects.toMatchObject({
        name: "RotatedCredentialError",
      })
      expect(getActiveCredentialId()).toBe(a.credentialId)
    } finally {
      restore()
    }
  })
})

describe("WebAlphaAuthService key/session management", () => {
  it("getSecretKey is undefined until commitSecret (memory-only MSK)", async () => {
    const { service } = laptop()
    const created = await service.createPasskey("@alice")
    expect(await service.getSecretKey()).toBeUndefined()
    await service.commitSecret({ secretKey: created.secretKey, authProvider: created.authProvider })
    expect((await service.getSecretKey())?.toString()).toBe(created.secretKey.toString())
    service.clear()
    expect(await service.getSecretKey()).toBeUndefined()
  })

  it("getDerivedKey: unknown domain throws pre-unlock; known domain derives 32 bytes post-commit", async () => {
    const { service } = laptop()
    await expect(service.getDerivedKey("nope")).rejects.toThrow(/Unknown derived-key domain/)
    await expect(service.getDerivedKey("pending-store")).rejects.toThrow(/MSK is not available/)
    const created = await service.createPasskey("@alice")
    await service.commitSecret({ secretKey: created.secretKey, authProvider: created.authProvider })
    const key = await service.getDerivedKey("pending-store")
    expect(key).toHaveLength(32)
    expect(await service.getDerivedKey("pending-store")).toBe(key)
  })

  it("getAuthProvider rebuilds from the persisted MSK-root record after clear()", async () => {
    const { service } = laptop()
    expect(await service.getAuthProvider()).toBeUndefined()
    const created = await service.createPasskey("@alice")
    await record(service, created, "0xabc")
    service.clear()
    const provider = await service.getAuthProvider()
    expect(provider).toBeDefined()
    const [x, y] = await provider!.getPubkeys()
    expect(Buffer.concat([x, y]).toString("hex")).toBe(created.pubkey)
  })

  it("a signature while locked signs for real, reads no PRF, and leaves the session locked", async () => {
    const { service, ceremony } = laptop()
    const created = await service.createPasskey("@alice")
    await record(service, created, "0xabc")
    service.clear()
    const provider = (await service.getAuthProvider())!
    ceremony.assertRequests = []
    ceremony.opts.route = "local"
    const witness = await provider.createAuthWit(Fr.random())
    expect(witness).toBeDefined()
    expect(ceremony.assertRequests).toHaveLength(1)
    expect(ceremony.assertRequests[0]!.prfFirstSalt).toBeUndefined()
    expect(ceremony.assertRequests[0]!.prfSecondSalt).toBeUndefined()
    expect(await service.getSecretKey()).toBeUndefined()
  })
})

describe("WebAlphaAuthService — one prompt, no picker", () => {
  it("recovery without an explicit id names the recorded root passkey to the authenticator", async () => {
    const { service, ceremony } = laptop()
    const created = await service.createPasskey("@alice")
    await record(service, created, "0xabc")
    service.clear()
    ceremony.asserts = []

    await service.recoverPasskey({})
    expect(ceremony.asserts).toEqual([[created.credentialId]])
  })

  it("adoptKnownPasskey: one assertion on the hinted credential, key checked against the signature", async () => {
    const { service, ceremony } = laptop()
    const created = await service.createPasskey("@alice")
    service.clear()
    ceremony.asserts = []

    const adopted = await service.adoptKnownPasskey({
      credentialId: created.credentialId,
      pubkeyHex: created.pubkey,
    })
    expect(ceremony.asserts).toEqual([[created.credentialId]])
    expect(adopted.pubkey).toBe(created.pubkey)
    expect(adopted.candidates.first?.toString()).toBe(created.secretKey.toString())
    expect(adopted.candidates.second).toBeDefined()

    const other = await service.createPasskey("@bob")
    await expect(
      service.adoptKnownPasskey({
        credentialId: created.credentialId,
        pubkeyHex: other.pubkey,
      }),
    ).rejects.toMatchObject({ name: "HintedKeyMismatchError" })
  })

  it("adoptKnownPasskey refuses a device-bound passkey on the device that holds it", async () => {
    const { service, ceremony } = phone()
    const created = await service.createPasskey("@alice")
    ceremony.opts.backupEligible = false
    await expect(
      service.adoptKnownPasskey({ credentialId: created.credentialId, pubkeyHex: created.pubkey }),
    ).rejects.toMatchObject({ name: "DeviceBoundPasskeyError" })
  })

  it("adoptKnownPasskey accepts a security key, which reports no backup", async () => {
    const { service } = laptop({
      manager: "security-key",
      transports: ["usb"],
      backupEligible: false,
    })
    const created = await service.createPasskey("@alice")
    const adopted = await service.adoptKnownPasskey({
      credentialId: created.credentialId,
      pubkeyHex: created.pubkey,
    })
    expect(adopted.candidates.first?.toString()).toBe(created.secretKey.toString())
  })

  it("adoptKnownPasskey sends a recorded hardware key's transports on a laptop, so the sheet opens on the key", async () => {
    const { service, ceremony } = laptop(KEY)
    const created = await service.createPasskey("@alice")
    await record(service, created, "0xalice")
    service.clear()
    await service.adoptKnownPasskey({ credentialId: created.credentialId, pubkeyHex: created.pubkey })
    expect(ceremony.assertRequests.at(-1)!.transports).toEqual(["usb"])
  })

  it("adoptKnownPasskey sends nothing for a synced record on a laptop: a hybrid list would hide the local copy", async () => {
    const { service, ceremony } = laptop({ transports: ["hybrid", "internal"] })
    const created = await service.createPasskey("@alice")
    await record(service, created, "0xalice")
    service.clear()
    await service.adoptKnownPasskey({ credentialId: created.credentialId, pubkeyHex: created.pubkey })
    expect(ceremony.assertRequests.at(-1)!.transports).toBeUndefined()
  })

  it("adoptKnownPasskey sends nothing for a credential with no record, or with only an inferred list", async () => {
    const { service, ceremony, storage } = laptop(KEY)
    const created = await service.createPasskey("@alice")
    service.clear()
    await service.adoptKnownPasskey({ credentialId: created.credentialId, pubkeyHex: created.pubkey })
    expect(ceremony.assertRequests.at(-1)!.transports).toBeUndefined()

    await service.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xalice",
      pubkey: created.pubkey,
      prfSlot: created.prfSlot,
      isMskRoot: true,
    })
    const { WebPasskeyIdentityMap } = await import("../src/platform/auth/WebPasskeyIdentityMap")
    await new WebPasskeyIdentityMap(storage, "localhost").setInferredTransports(
      created.credentialId,
      ["usb"],
    )
    service.clear()
    await service.adoptKnownPasskey({ credentialId: created.credentialId, pubkeyHex: created.pubkey })
    // The inference steers signatures (`steeringFor`); the recovery assertion sends only a creation list.
    expect(ceremony.assertRequests.at(-1)!.transports).toBeUndefined()
  })

  it("adoptKnownPasskey names a security key on a laptop only for a credential known to be one", async () => {
    // A recorded hardware key: named, so the sheet keeps its row and a manager's extension stands aside.
    const key = laptop(KEY)
    const created = await key.service.createPasskey("@alice")
    await record(key.service, created, "0xalice")
    key.service.clear()
    await key.service.adoptKnownPasskey({
      credentialId: created.credentialId,
      pubkeyHex: created.pubkey,
    })
    expect(key.ceremony.assertRequests.at(-1)!.hints).toEqual(["client-device", "security-key"])

    // A synced record: not named, so the extension may answer from its copy.
    const synced = laptop({ transports: ["hybrid", "internal"] })
    const made = await synced.service.createPasskey("@alice")
    await record(synced.service, made, "0xalice")
    synced.service.clear()
    await synced.service.adoptKnownPasskey({ credentialId: made.credentialId, pubkeyHex: made.pubkey })
    expect(synced.ceremony.assertRequests.at(-1)!.hints).toEqual(["client-device"])

    // No record: not named either. The key that answers teaches the session, so the next request names one.
    const unseen = laptop(KEY)
    const fresh = await unseen.service.createPasskey("@alice")
    unseen.service.clear()
    await unseen.service.adoptKnownPasskey({ credentialId: fresh.credentialId, pubkeyHex: fresh.pubkey })
    expect(unseen.ceremony.assertRequests.at(-1)!.hints).toEqual(["client-device"])
    await unseen.service.adoptKnownPasskey({ credentialId: fresh.credentialId, pubkeyHex: fresh.pubkey })
    expect(unseen.ceremony.assertRequests.at(-1)!.hints).toEqual(["client-device", "security-key"])
  })

  it("adoptKnownPasskey on a phone passes a record's list through, as beginRecovery does", async () => {
    const { service, ceremony } = phone({ transports: ["hybrid", "internal"] })
    const created = await service.createPasskey("@alice")
    await record(service, created, "0xalice")
    service.clear()
    await service.adoptKnownPasskey({ credentialId: created.credentialId, pubkeyHex: created.pubkey })
    expect(ceremony.assertRequests.at(-1)!.transports).toEqual(["hybrid", "internal"])
  })

  it("adoptKnownPasskey honours this browser's record: its address anchors, a rotated credential is refused", async () => {
    const { service } = laptop()
    const created = await service.createPasskey("@alice")
    await record(service, created, "0xalice")
    service.clear()
    const hint = {
      credentialId: created.credentialId,
      pubkeyHex: created.pubkey,
    }

    const adopted = await service.adoptKnownPasskey(hint)
    expect(adopted.expectedAddress).toBe("0xalice")
    expect(adopted.preferredSlot).toBe("first")
    expect(adopted.hasPersistedSlot).toBe(true)

    await service.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xalice",
      pubkey: created.pubkey,
      isMskRoot: false,
    })
    await expect(service.adoptKnownPasskey(hint)).rejects.toMatchObject({
      name: "RotatedCredentialError",
    })
  })
})

describe("WebAlphaAuthService cached key restore", () => {
  const ADDR = `0x${"aa".repeat(32)}`

  /** Pause a restore at address derivation so a commit or sign-out can land first. */
  function hangDerive(answer: (msk: Fr, pubkeyHex: string) => string = () => ADDR) {
    let release!: () => void
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    return {
      ready,
      derive: (msk: Fr, pubkeyHex: string) =>
        new Promise<string>((resolve) => {
          release = () => resolve(answer(msk, pubkeyHex))
          started()
        }),
      release: () => release(),
    }
  }

  /** A session committed with its passkey, and a second instance over the same storage. */
  async function committed(opts: { address?: string } = {}) {
    const restore = stubLocalStorage()
    const { service, ceremony, storage } = laptop()
    const created = await service.createPasskey("@alice")
    await record(service, created, opts.address ?? ADDR)
    await service.commitSecret({ secretKey: created.secretKey, authProvider: created.authProvider })
    const fresh = new WebAlphaAuthService({
      storage,
      rpId: "localhost",
      ceremony,
      posture: () => "laptop",
    })
    const snapshot = {
      kind: "webauthn" as const,
      credentialId: created.credentialId,
      pubkey: created.pubkey,
      address: ADDR,
    }
    const inject = (
      over: {
        derive?: (msk: Fr, pubkeyHex: string) => Promise<string>
        read?: () => Promise<typeof snapshot | null | { kind: "other" }>
      } = {},
    ) => {
      fresh.setAddressDeriver(over.derive ?? deriveFor(created, ADDR))
      fresh.setAccountReader(over.read ?? (async () => snapshot))
    }
    const ceremonies = () => ceremony.assertRequests.length
    return { restore, service, ceremony, storage, created, fresh, inject, snapshot, ceremonies }
  }

  it("commit writes the cache next to the pointers", async () => {
    const { restore, created } = await committed()
    try {
      const cache = JSON.parse(localStorage.getItem("webwallet.msk")!)
      expect(cache).toEqual({
        v: 1,
        storageId: getActiveStorageId(),
        credentialId: created.credentialId,
        msk: created.secretKey.toString(),
      })
      expect(getActiveCredentialId()).toBe(created.credentialId)
    } finally {
      restore()
    }
  })

  it("a fresh instance restores the key and the record's provider with no ceremony", async () => {
    const { restore, created, fresh, inject, ceremonies } = await committed()
    try {
      const before = ceremonies()
      const derive = vi.fn(deriveFor(created, ADDR))
      inject({ derive })
      expect((await fresh.getSecretKey())?.toString()).toBe(created.secretKey.toString())
      expect(fresh.isUnlocked()).toBe(true)
      const provider = await fresh.getAuthProvider()
      const [x, y] = await provider!.getPubkeys()
      expect(Buffer.concat([x, y]).toString("hex")).toBe(created.pubkey)
      expect(ceremonies()).toBe(before)
      // The cached key is proved under the record's signing key.
      expect(derive).toHaveBeenCalledWith(created.secretKey, created.pubkey)
    } finally {
      restore()
    }
  })

  it("an address that exists only under another signing key drops the cache", async () => {
    const { restore, fresh, inject } = await committed()
    try {
      inject({
        derive: async (_msk, pubkeyHex) => (pubkeyHex === "ff".repeat(64) ? ADDR : "0xother"),
      })
      expect(await fresh.getSecretKey()).toBeUndefined()
      expect(localStorage.getItem("webwallet.msk")).toBeNull()
    } finally {
      restore()
    }
  })

  it("two roots on the browser: the restored provider is the active credential's, not the newest", async () => {
    const { restore, created, fresh, inject, storage, ceremony } = await committed()
    try {
      // A newer root passkey made on this browser for another account.
      const other = new WebAlphaAuthService({
        storage,
        rpId: "localhost",
        ceremony,
        posture: () => "laptop",
      })
      const newer = await other.createPasskey("@bob")
      await record(other, newer, `0x${"bb".repeat(32)}`)
      // Before the wallet exists a recorded root is all the service has to sign with; the proved
      // cache replaces it.
      const early = await fresh.getAuthProvider()
      expect(early).toBeDefined()
      expect(fresh.isUnlocked()).toBe(false)
      inject()
      const provider = await fresh.getAuthProvider()
      expect(provider).not.toBe(early)
      const [x, y] = await provider!.getPubkeys()
      expect(Buffer.concat([x, y]).toString("hex")).toBe(created.pubkey)
      expect(created.pubkey).not.toBe(newer.pubkey)
    } finally {
      restore()
    }
  })

  it("unlock() takes the proved cache before any ceremony", async () => {
    const { restore, created, fresh, inject, ceremonies } = await committed()
    try {
      const before = ceremonies()
      inject()
      await fresh.unlock(deriveFor(created, ADDR), {})
      expect(fresh.isUnlocked()).toBe(true)
      expect(ceremonies()).toBe(before)
    } finally {
      restore()
    }
  })

  it("restores nothing until the wallet has injected a deriver and a reader", async () => {
    const { restore, fresh } = await committed()
    try {
      expect(await fresh.getSecretKey()).toBeUndefined()
      expect(localStorage.getItem("webwallet.msk")).not.toBeNull()
    } finally {
      restore()
    }
  })

  it.each([
    ["the storage pointer moved", () => setActiveStorageId("someone-else")],
    ["the credential pointer moved", () => setActiveCredentialId("someone-else")],
  ])(
    "%s: the cache is dropped, this tab's own pointers stay, the service stays locked",
    async (_name, disturb) => {
      const { restore, fresh, inject } = await committed()
      try {
        disturb()
        const session = { storageId: getActiveStorageId()!, credentialId: getActiveCredentialId() }
        inject()
        expect(await fresh.getSecretKey()).toBeUndefined()
        expect(localStorage.getItem("webwallet.msk")).toBeNull()
        expect(getActiveStorageId()).toBe(session.storageId)
        expect(getActiveCredentialId()).toBe(session.credentialId)
      } finally {
        restore()
      }
    },
  )

  it("no record, a record without an address, or a rotated record: dropped and locked", async () => {
    for (const shape of ["missing", "no-address", "rotated", "wrong-rp"] as const) {
      const { restore, fresh, inject, storage, created } = await committed()
      try {
        const { WebPasskeyIdentityMap } = await import("../src/platform/auth/WebPasskeyIdentityMap")
        const map = new WebPasskeyIdentityMap(storage, "localhost")
        if (shape === "missing") await map.clear()
        if (shape === "wrong-rp") {
          await new WebPasskeyIdentityMap(storage, "auth.zk.money").upsert({
            credentialId: created.credentialId,
            l2Address: ADDR,
            pubkey: created.pubkey,
            isMskRoot: true,
          })
        }
        if (shape === "no-address") {
          await map.upsert({
            credentialId: created.credentialId,
            l2Address: "",
            pubkey: created.pubkey,
            isMskRoot: true,
          })
        }
        if (shape === "rotated") {
          await map.upsert({
            credentialId: created.credentialId,
            l2Address: ADDR,
            pubkey: created.pubkey,
            isMskRoot: false,
          })
        }
        inject()
        expect(await fresh.getSecretKey()).toBeUndefined()
        expect(localStorage.getItem("webwallet.msk")).toBeNull()
      } finally {
        restore()
      }
    }
  })

  it("a key that does not re-derive the storage id is dropped", async () => {
    const { restore, fresh, inject } = await committed()
    try {
      const cache = JSON.parse(localStorage.getItem("webwallet.msk")!)
      cache.msk = Fr.random().toString()
      localStorage.setItem("webwallet.msk", JSON.stringify(cache))
      inject()
      expect(await fresh.getSecretKey()).toBeUndefined()
      expect(localStorage.getItem("webwallet.msk")).toBeNull()
    } finally {
      restore()
    }
  })

  it.each([
    ["another address", (s: { address: string }) => ({ ...s, address: `0x${"cc".repeat(32)}` })],
    ["another passkey key", (s: { pubkey: string }) => ({ ...s, pubkey: "ff".repeat(64) })],
    ["another credential", (s: { credentialId: string }) => ({ ...s, credentialId: "cred-other" })],
    ["a non-passkey account", () => ({ kind: "other" as const })],
    ["no stored account", () => null],
  ])("a stored account with %s is a mismatch: dropped and locked", async (_name, twist) => {
    const { restore, fresh, inject, snapshot } = await committed()
    try {
      inject({ read: async () => twist(snapshot) as never })
      expect(await fresh.getSecretKey()).toBeUndefined()
      expect(fresh.isUnlocked()).toBe(false)
      expect(localStorage.getItem("webwallet.msk")).toBeNull()
      expect(getActiveStorageId()).toBeNull()
    } finally {
      restore()
    }
  })

  it("a key deriving another address than the record's is dropped", async () => {
    const { restore, fresh, inject } = await committed()
    try {
      inject({ derive: async () => `0x${"dd".repeat(32)}` })
      expect(await fresh.getSecretKey()).toBeUndefined()
      expect(localStorage.getItem("webwallet.msk")).toBeNull()
    } finally {
      restore()
    }
  })

  it("a wallet that cannot answer leaves the cache for the next attempt", async () => {
    const { restore, fresh, inject } = await committed()
    try {
      inject({
        derive: async () => {
          throw new Error("pxe down")
        },
      })
      expect(await fresh.getSecretKey()).toBeUndefined()
      expect(localStorage.getItem("webwallet.msk")).not.toBeNull()
      expect(getActiveStorageId()).not.toBeNull()
    } finally {
      restore()
    }
  })

  it("a commit that lands during a restore wins, and the cache reflects it", async () => {
    const { restore, fresh, inject, created, ceremony, storage } = await committed()
    try {
      const hung = hangDerive((msk) => (msk.equals(created.secretKey) ? ADDR : "0xother"))
      inject({ derive: hung.derive })
      const pending = fresh.getSecretKey()
      await hung.ready
      // The user finished a ceremony for another account in this tab meanwhile.
      const other = new WebAlphaAuthService({
        storage,
        rpId: "localhost",
        ceremony,
        posture: () => "laptop",
      })
      const newer = await other.createPasskey("@bob")
      fresh.setAddressDeriver(async () => ADDR)
      await fresh.commitSecret({
        secretKey: newer.secretKey,
        authProvider: fresh.providerFor({
          credentialId: newer.credentialId,
          pubkeyHex: newer.pubkey,
        }),
      })
      hung.release()
      expect((await pending)?.toString()).toBe(newer.secretKey.toString())
      expect(JSON.parse(localStorage.getItem("webwallet.msk")!).msk).toBe(
        newer.secretKey.toString(),
      )
    } finally {
      restore()
    }
  })

  it("a sign-out that lands during a restore leaves the service locked", async () => {
    const { restore, fresh, inject } = await committed()
    try {
      const hung = hangDerive()
      inject({ derive: hung.derive })
      const pending = fresh.getSecretKey()
      await hung.ready
      fresh.clear()
      clearActiveStorage()
      hung.release()
      expect(await pending).toBeUndefined()
      expect(fresh.isUnlocked()).toBe(false)
      expect(localStorage.getItem("webwallet.msk")).toBeNull()
    } finally {
      restore()
    }
  })

  it("another session's blob under this tab's own pointers goes alone; the session stays", async () => {
    const { restore, fresh, inject } = await committed()
    try {
      writeCachedMsk({
        v: 1,
        storageId: "theirs",
        credentialId: "cred-theirs",
        msk: Fr.random().toString(),
      })
      inject()
      expect(await fresh.getSecretKey()).toBeUndefined()
      expect(readCachedMsk()).toBeNull()
      expect(getActiveStorageId()).not.toBeNull()
    } finally {
      restore()
    }
  })

  it("lockOut() keeps a cache from restoring until the next commit", async () => {
    const { restore, created, fresh, inject } = await committed()
    try {
      inject()
      fresh.lockOut()
      expect(await fresh.getSecretKey()).toBeUndefined()
      expect(readCachedMsk()).not.toBeNull()
      await fresh.commitSecret({
        secretKey: created.secretKey,
        authProvider: fresh.providerFor({
          credentialId: created.credentialId,
          pubkeyHex: created.pubkey,
        }),
      })
      fresh.clear()
      expect((await fresh.getSecretKey())?.toString()).toBe(created.secretKey.toString())
    } finally {
      restore()
    }
  })

  it("clear() then a read restores while the cache exists; without the cache it stays locked", async () => {
    const { restore, service, created } = await committed()
    try {
      service.setAddressDeriver(deriveFor(created, ADDR))
      service.setAccountReader(async () => ({
        kind: "webauthn",
        credentialId: created.credentialId,
        pubkey: created.pubkey,
        address: ADDR,
      }))
      service.clear()
      expect((await service.getSecretKey())?.toString()).toBe(created.secretKey.toString())
      const { clearCachedMsk } = await import("../src/platform/storage/activeStorage")
      clearCachedMsk()
      service.clear()
      expect(await service.getSecretKey()).toBeUndefined()
    } finally {
      restore()
    }
  })

  it("a signature after a restore signs for real and reads no PRF", async () => {
    const { restore, fresh, inject, ceremony } = await committed()
    try {
      inject()
      const provider = (await fresh.getAuthProvider())!
      const before = ceremony.assertRequests.length
      await provider.createAuthWit(Fr.random())
      const request = ceremony.assertRequests[before]!
      expect(request.prfFirstSalt).toBeUndefined()
      expect(request.prfSecondSalt).toBeUndefined()
    } finally {
      restore()
    }
  })

  it("a store that refuses the pointers fails the commit rather than half-doing it", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError")
      },
      removeItem: () => {
        throw new Error("QuotaExceededError")
      },
    })
    try {
      const { service } = laptop()
      const created = await service.createPasskey("@alice")
      // Two dozen bytes refused means the store is refusing everything. The caller hears about it
      // instead of being handed a session with nowhere to write.
      await expect(
        service.commitSecret({ secretKey: created.secretKey, authProvider: created.authProvider }),
      ).rejects.toThrow()
      expect(service.isUnlocked()).toBe(false)
      expect(getActiveStorageId()).toBeNull()
      expect(getActiveCredentialId()).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("a pointer write refused halfway puts the previous session's pointers back", async () => {
    let refused: readonly string[] = []
    const restore = stubLocalStorage(() => refused)
    try {
      const { service } = laptop()
      const first = await service.createPasskey("@alice")
      await record(service, first, ADDR)
      await service.commitSecret({
        secretKey: first.secretKey,
        authProvider: first.authProvider,
      })
      const held = { id: getActiveStorageId(), cred: getActiveCredentialId() }

      // The namespace write lands, the credential write does not: the pair must not be left split
      // across two accounts, which would run this key against the other one's records.
      const second = await service.createPasskey("@bob")
      refused = ["webwallet.credentialId"]
      await expect(
        service.commitSecret({
          secretKey: second.secretKey,
          authProvider: second.authProvider,
        }),
      ).rejects.toThrow()
      refused = []

      expect(getActiveStorageId()).toBe(held.id)
      expect(getActiveCredentialId()).toBe(held.cred)
      expect(readCachedMsk()).toMatchObject({ storageId: held.id, credentialId: held.cred })
      // The session that was there is still the one this tab holds.
      expect((await service.getSecretKey())?.toString()).toBe(first.secretKey.toString())
    } finally {
      restore()
    }
  })

  it("a refused key cache keeps the namespace, and the reload asks for the passkey", async () => {
    const map = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (k === "webwallet.msk") throw new Error("QuotaExceededError")
        map.set(k, v)
      },
      removeItem: (k: string) => void map.delete(k),
    })
    try {
      const { service } = laptop()
      const created = await service.createPasskey("@alice")
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      // The session is usable here and coherent on disk: this account's namespace and credential,
      // no key — which is what an ordinary locked session looks like.
      expect(service.isUnlocked()).toBe(true)
      expect(getActiveStorageId()).not.toBeNull()
      expect(getActiveCredentialId()).toBe(created.credentialId)
      expect(readCachedMsk()).toBeNull()
      expect(service.keyCached()).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("a refused key cache leaves no earlier session's key readable", async () => {
    const map = new Map<string, string>()
    let refuse = false
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (refuse && k === "webwallet.msk") throw new Error("QuotaExceededError")
        map.set(k, v)
      },
      removeItem: (k: string) => void map.delete(k),
    })
    try {
      const { service } = laptop()
      const a = await service.createPasskey("@alice")
      await service.commitSecret({ secretKey: a.secretKey, authProvider: a.authProvider })
      expect(readCachedMsk()).not.toBeNull()
      refuse = true
      const b = await service.createPasskey("@bob")
      await service.commitSecret({ secretKey: b.secretKey, authProvider: b.authProvider })
      // Alice's key belongs to nobody now that the tab holds Bob's session.
      expect(readCachedMsk()).toBeNull()
      expect(getActiveCredentialId()).toBe(b.credentialId)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("a demo commit without a passkey caches nothing and drops a passkey session's cache", async () => {
    const restore = stubLocalStorage()
    try {
      const { EcdsaK256AlphaAuthProvider } = await import("@obsidion/sdk")
      const { service } = laptop()
      const created = await service.createPasskey("@alice")
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      expect(localStorage.getItem("webwallet.msk")).not.toBeNull()
      await service.commitSecret({
        secretKey: Fr.random(),
        authProvider: new EcdsaK256AlphaAuthProvider(Buffer.alloc(32, 7)),
      })
      expect(service.isUnlocked()).toBe(true)
      expect(localStorage.getItem("webwallet.msk")).toBeNull()
      expect(getActiveStorageId()).not.toBeNull()
      expect(getActiveCredentialId()).toBeNull()
    } finally {
      restore()
    }
  })
})

describe("WebAlphaAuthService stale page records", () => {
  type Created = Awaited<ReturnType<WebAlphaAuthService["createPasskey"]>>
  const commit = (service: WebAlphaAuthService, created: Created) =>
    service.commitSecret({ secretKey: created.secretKey, authProvider: created.authProvider })
  /** Leaves a record under `created`'s account, as an earlier session on this browser would. */
  const holdRecords = async (created: Created) => {
    const id = await storageIdFromSecret(new Uint8Array(created.secretKey.toBuffer()))
    localStorage.setItem(`obsidion.${id}.obsidion_account`, "{}")
  }

  it("a first sign-in on a browser that never held the account leaves them fresh", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = laptop()
      await commit(service, await service.createPasskey("@alice"))
      expect(service.recordsStale()).toBe(false)
    } finally {
      restore()
    }
  })

  it("signing in with no session to an account this browser holds marks them stale", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = laptop()
      const created = await service.createPasskey("@alice")
      await holdRecords(created)
      await commit(service, created)
      expect(service.recordsStale()).toBe(true)
    } finally {
      restore()
    }
  })

  it("committing the active account again leaves them fresh", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = laptop()
      const created = await service.createPasskey("@alice")
      await commit(service, created)
      await commit(service, created)
      expect(service.recordsStale()).toBe(false)
    } finally {
      restore()
    }
  })

  it("switching from one account to another marks them stale", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = laptop()
      await commit(service, await service.createPasskey("@alice"))
      await commit(service, await service.createPasskey("@bob"))
      expect(service.recordsStale()).toBe(true)
    } finally {
      restore()
    }
  })

  it("stays stale through a later commit of the same account", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = laptop()
      const created = await service.createPasskey("@alice")
      await holdRecords(created)
      await commit(service, created)
      await commit(service, created)
      expect(service.recordsStale()).toBe(true)
    } finally {
      restore()
    }
  })

  it("shared keys and keys written with no account do not count as held", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = laptop()
      localStorage.setItem("obsidion.obsidion_web_passkey_identity_map", "{}")
      localStorage.setItem("obsidion.obsidion_withdrawals", "{}")
      await commit(service, await service.createPasskey("@alice"))
      expect(service.recordsStale()).toBe(false)
    } finally {
      restore()
    }
  })

  it("a refused pointer write changes nothing", async () => {
    let refused: readonly string[] = []
    const restore = stubLocalStorage(() => refused)
    try {
      const { service } = laptop()
      await commit(service, await service.createPasskey("@alice"))
      const second = await service.createPasskey("@bob")
      refused = ["webwallet.credentialId"]
      await expect(commit(service, second)).rejects.toThrow()
      expect(service.recordsStale()).toBe(false)
    } finally {
      restore()
    }
  })

  it("an attempt that ended before the commit changes nothing", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = laptop()
      const created = await service.createPasskey("@alice")
      await holdRecords(created)
      const input = { secretKey: created.secretKey, authProvider: created.authProvider }
      expect(await service.commitSecret(input, () => false)).toBe(false)
      expect(service.recordsStale()).toBe(false)
    } finally {
      restore()
    }
  })

  it("a warm unlock of the active session leaves them fresh", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = laptop()
      const created = await service.createPasskey("@alice")
      await record(service, created, "0xacct")
      await commit(service, created)
      service.clear()
      await service.unlock(deriveFor(created, "0xacct"))
      expect(service.recordsStale()).toBe(false)
    } finally {
      restore()
    }
  })
})

describe("WebAlphaAuthService ceremony-free sources", () => {
  const ADDR = `0x${"aa".repeat(32)}`
  const material = (over: Partial<HandoffMaterial> = {}): HandoffMaterial => ({
    v: 1,
    derivedAt: Date.now(),
    rpId: "localhost",
    credentialId: "cred-camp",
    pubkeyHex: `0x${"ab".repeat(64)}`,
    candidates: { first: Fr.random().toString(), second: Fr.random().toString() },
    ...over,
  })

  it("hand-off material on a fresh browser: both candidates, a provider for its passkey, no ceremony", async () => {
    const { service, ceremony } = laptop()
    const m = material()
    const recovered = await service.recoverFromHandoffMaterial(m)
    expect(ceremony.assertRequests).toHaveLength(0)
    expect(recovered.credentialId).toBe("cred-camp")
    expect(recovered.pubkey).toBe("ab".repeat(64))
    expect(recovered.candidates.first?.toString()).toBe(m.candidates.first)
    expect(recovered.candidates.second?.toString()).toBe(m.candidates.second)
    expect(recovered.expectedAddress).toBeUndefined()
    expect(recovered.preferredSlot).toBe("first")
    expect(recovered.hasPersistedSlot).toBe(false)
    expect(recovered.candidateSource).toBe("webauthn")
    const [x, y] = await recovered.authProvider.getPubkeys()
    expect(Buffer.concat([x, y]).toString("hex")).toBe("ab".repeat(64))
  })

  it("hand-off material for a passkey this browser recorded anchors on that record", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = laptop()
      await service.recordRecoveryMetadata({
        credentialId: "cred-camp",
        l2Address: ADDR,
        pubkey: "ab".repeat(64),
        prfSlot: "second",
        isMskRoot: true,
      })
      const recovered = await service.recoverFromHandoffMaterial(material())
      expect(recovered.expectedAddress).toBe(ADDR)
      expect(recovered.preferredSlot).toBe("second")
    } finally {
      restore()
    }
  })

  it("hand-off material naming another key than this browser's record is a rotated-credential refusal", async () => {
    const { service } = laptop()
    await service.recordRecoveryMetadata({
      credentialId: "cred-camp",
      l2Address: ADDR,
      pubkey: "cd".repeat(64),
      isMskRoot: true,
    })
    await expect(service.recoverFromHandoffMaterial(material())).rejects.toMatchObject({
      name: "RotatedCredentialError",
    })
  })

  it.each([
    ["not hex", "0xnope"],
    ["above the field modulus", `0x${"ff".repeat(32)}`],
  ])("hand-off material with no usable candidate (%s) is refused", async (_name, first) => {
    const { service } = laptop()
    await expect(
      service.recoverFromHandoffMaterial(material({ candidates: { first } })),
    ).rejects.toMatchObject({ name: "NoPrfError" })
  })

  it("hand-off material's creation transports ride on the result, and only when carried", async () => {
    const { service } = laptop()
    expect((await service.recoverFromHandoffMaterial(material({ transports: ["usb"] }))).transports)
      .toEqual(["usb"])
    expect(await service.recoverFromHandoffMaterial(material())).not.toHaveProperty("transports")
  })

  it("a record written from hand-off material steers the next unlock like a wallet-created one", async () => {
    const { service, ceremony } = laptop({ transports: ["hybrid", "internal"] })
    const created = await service.createPasskey("@alice")
    const storage = new MemoryStorage()
    const fresh = freshOver(ceremony, storage)
    const recovered = await fresh.recoverFromHandoffMaterial(
      material({
        credentialId: created.credentialId,
        pubkeyHex: `0x${created.pubkey}`,
        candidates: { first: created.secretKey.toString() },
        transports: ["hybrid", "internal"],
      }),
    )
    await fresh.recordRecoveryMetadata({
      credentialId: recovered.credentialId,
      l2Address: ADDR,
      pubkey: recovered.pubkey,
      prfSlot: "first",
      isMskRoot: true,
      transports: recovered.transports,
    })
    expect((await storedEntry(storage, created.credentialId)).transports).toEqual([
      "hybrid",
      "internal",
    ])
    await fresh.beginRecovery({ credentialId: created.credentialId })
    // A laptop sends nothing for a synced list, as for a wallet-created record: it would hide the
    // local copy the sign-in admits.
    expect(ceremony.assertRequests.at(-1)!.transports).toBeUndefined()
  })

  it("a hand-off list the wallet does not name steers no signature and no laptop unlock, and blocks inference", async () => {
    const { service, ceremony } = laptop(KEY)
    const created = await service.createPasskey("@alice")
    const storage = new MemoryStorage()
    const fresh = freshOver(ceremony, storage)
    const recovered = await fresh.recoverFromHandoffMaterial(
      material({
        credentialId: created.credentialId,
        pubkeyHex: `0x${created.pubkey}`,
        candidates: { first: created.secretKey.toString() },
        transports: ["future-token"],
      }),
    )
    await fresh.recordRecoveryMetadata({
      credentialId: recovered.credentialId,
      l2Address: ADDR,
      pubkey: recovered.pubkey,
      prfSlot: "first",
      isMskRoot: true,
      transports: recovered.transports,
    })
    await signWith(fresh.providerFor({ credentialId: created.credentialId, pubkeyHex: created.pubkey }))
    expect(ceremony.assertRequests.at(-1)!).not.toHaveProperty("transports")
    await fresh.beginRecovery({ credentialId: created.credentialId })
    // Not physical-only, so a laptop unlock sends no restriction either.
    expect(ceremony.assertRequests.at(-1)!.transports).toBeUndefined()
    await flush()
    const entry = await storedEntry(storage, created.credentialId)
    expect(entry.transports).toEqual(["future-token"])
    expect(entry.inferredTransports).toBeUndefined()
  })

  it("the cache source is the held key under its record's slot and address, and nothing when locked", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, ceremony } = laptop()
      expect(await service.recoverFromCache()).toBeUndefined()
      const created = await service.createPasskey("@alice")
      await record(service, created, ADDR)
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      const before = ceremony.assertRequests.length
      const cached = await service.recoverFromCache()
      expect(cached?.credentialId).toBe(created.credentialId)
      expect(cached?.expectedAddress).toBe(ADDR)
      expect(cached?.candidates[created.prfSlot!]?.toString()).toBe(created.secretKey.toString())
      expect(cached?.authProvider).toBe(created.authProvider)
      expect(ceremony.assertRequests).toHaveLength(before)
      service.clear()
      const { clearCachedMsk } = await import("../src/platform/storage/activeStorage")
      clearCachedMsk()
      expect(await service.recoverFromCache()).toBeUndefined()
    } finally {
      restore()
    }
  })

  it("the cache source with restore:false consults only the key in memory and never runs the proof", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = laptop()
      const created = await service.createPasskey("@alice")
      await record(service, created, ADDR)
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      expect((await service.recoverFromCache({ restore: false }))?.credentialId).toBe(
        created.credentialId,
      )
      service.clear()
      const proof = vi.spyOn(
        service as unknown as { restoreFromCache: () => Promise<void> },
        "restoreFromCache",
      )
      expect(await service.recoverFromCache({ restore: false })).toBeUndefined()
      expect(proof).not.toHaveBeenCalled()
      // The disk cache is left for the next restoring read.
      expect(readCachedMsk()?.credentialId).toBe(created.credentialId)
    } finally {
      restore()
    }
  })

  it("the cache source needs a record for the bound passkey", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = laptop()
      const created = await service.createPasskey("@alice")
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      expect(await service.recoverFromCache()).toBeUndefined()
    } finally {
      restore()
    }
  })
})

describe("the wallet's own checks around the shared ceremony sequence", () => {
  it("laptop: a locally answered second assertion in public-key recovery is accepted", async () => {
    const inner = new FakePasskeyCeremony({ route: "cross-device" })
    let asserts = 0
    const ceremony: PasskeyCeremony = {
      create: (request) => inner.create(request),
      assert: async (request) => {
        const result = await inner.assert(request)
        return ++asserts === 2 ? { ...result, authenticatorAttachment: "platform" } : result
      },
    }
    const options = { rpId: "localhost", ceremony, posture: () => "laptop" as const }
    const creator = new WebAlphaAuthService({ storage: new MemoryStorage(), ...options })
    const created = await creator.createPasskey("@alice")
    // A fresh browser holds no record, so recovery takes the second, salt-free assertion. The
    // device that answers it is not the account's business: a laptop holding a synced copy signs
    // on the spot rather than being sent back to the phone for a signature over a random challenge.
    const fresh = new WebAlphaAuthService({ storage: new MemoryStorage(), ...options })
    const recovered = await fresh.recoverPasskey({
      credentialId: created.credentialId,
    })
    expect(recovered.pubkey).toBe(created.pubkey)
    expect(asserts).toBe(2)
    // The first assertion reads both salts and takes the route steering; the second only signs.
    expect(inner.assertRequests[0]!.prfSecondSalt).toBeDefined()
    expect(inner.assertRequests[1]!.prfFirstSalt).toBeUndefined()
    expect(inner.assertRequests[1]!.prfSecondSalt).toBeUndefined()
    expect(inner.assertRequests[1]!.hints).toBeUndefined()
    expect(inner.assertRequests[1]!.transports).toBeUndefined()
    expect(inner.assertRequests[1]!.credentialIds).toEqual([created.credentialId])
  })

  it("a rotated credential is refused before the gates, on recovery and on adoption", async () => {
    // Another device's answer is exempt from the backup gate, so the gate this ordering has to
    // beat is the unreadable-flag one.
    for (const gap of [{ prfAtAssert: false }, { backupEligible: "unknown" as const }]) {
      const { service, ceremony } = laptop()
      const created = await service.createPasskey("@alice")
      await service.recordRecoveryMetadata({
        credentialId: created.credentialId,
        l2Address: `0x${"aa".repeat(32)}`,
        pubkey: created.pubkey,
        prfSlot: created.prfSlot,
        isMskRoot: false,
      })
      Object.assign(ceremony.opts, gap)
      await expect(
        service.recoverPasskey({ credentialId: created.credentialId }),
      ).rejects.toMatchObject({
        name: "RotatedCredentialError",
      })
      await expect(
        service.adoptKnownPasskey({
          credentialId: created.credentialId,
          pubkeyHex: created.pubkey,
        }),
      ).rejects.toMatchObject({ name: "RotatedCredentialError" })
    }
  })
})

/** A laptop over an authenticator that answers each request on the route the request implies. */
function dualRoute(over: FakeCeremonyOptions = {}) {
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
  return { service, ceremony, storage }
}

describe("WebAlphaAuthService laptop recovery", () => {
  it("a phone recovers without hints", async () => {
    const { service, ceremony } = phone()
    const created = await service.createPasskey("@alice")
    await record(service, created, "0xabc")
    service.clear()
    const recovered = await service.recoverPasskey({ credentialId: created.credentialId })
    expect(recovered.candidates.second?.toString()).toBe(created.secretKey.toString())
    expect(ceremony.assertRequests.at(-1)!.hints).toBeUndefined()
  })

  it("a laptop admits the local copy, sends no transports even with a hybrid-only record, and observes platform", async () => {
    const { service, ceremony } = dualRoute()
    const created = await service.createPasskey("@alice")
    await service.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xabc",
      pubkey: created.pubkey,
      prfSlot: created.prfSlot,
      isMskRoot: true,
      transports: ["hybrid"],
    })
    service.clear()
    const recovered = await service.recoverPasskey({
      credentialId: created.credentialId,
    })
    expect(recovered.observed).toEqual({
      credentialId: created.credentialId,
      attachment: "platform",
    })
    expect(recovered.candidates.second).toBeDefined()
    const request = ceremony.assertRequests.at(-1)!
    expect(request.transports).toBeUndefined()
    expect(request.hints).toEqual(["client-device"])
  })

  it("a laptop names a security key beside the local route for a recorded hardware key", async () => {
    const { service, ceremony } = laptop(KEY)
    const created = await service.createPasskey("@alice")
    await record(service, created, "0xabc")
    service.clear()
    await service.recoverPasskey({ credentialId: created.credentialId })
    const request = ceremony.assertRequests.at(-1)!
    expect(request.transports).toEqual(["usb"])
    expect(request.hints).toEqual(["client-device", "security-key"])
  })

  it("a key-settling second assertion keeps the first attempt's observation", async () => {
    const { ceremony } = dualRoute()
    const owner = new WebAlphaAuthService({
      storage: new MemoryStorage(),
      rpId: "localhost",
      ceremony,
      posture: () => "laptop",
    })
    const created = await owner.createPasskey("@alice")
    const fresh = new WebAlphaAuthService({
      storage: new MemoryStorage(),
      rpId: "localhost",
      ceremony,
      posture: () => "laptop",
    })
    const begun = await fresh.beginRecovery({
      credentialId: created.credentialId,
    })
    if (!isUnsettled(begun)) throw new Error("expected an unsettled recovery")
    expect(begun.observed).toEqual({ credentialId: created.credentialId, attachment: "platform" })
    const settled = await begun.settle()
    expect(settled.observed).toEqual({ credentialId: created.credentialId, attachment: "platform" })
  })

  it("a fresh browser this-device answer has no expected address and never commits unanchored", async () => {
    const { ceremony } = dualRoute()
    const owner = new WebAlphaAuthService({
      storage: new MemoryStorage(),
      rpId: "localhost",
      ceremony,
      posture: () => "laptop",
    })
    const created = await owner.createPasskey("@alice")
    const fresh = new WebAlphaAuthService({
      storage: new MemoryStorage(),
      rpId: "localhost",
      ceremony,
      posture: () => "laptop",
    })
    const recovered = await fresh.recoverPasskey({
      credentialId: created.credentialId,
    })
    expect(recovered.expectedAddress).toBeUndefined()
    expect(recovered.authenticatorType).toBe("platform")
    await expect(selectRecoveredMsk(recovered, async () => "0xabc")).rejects.toThrow(
      /no stored account address/,
    )
  })
})

describe("WebAlphaAuthService early-refusal observation", () => {
  it("an early no-PRF carries the observation", async () => {
    const { service } = dualRoute({ prfAtAssert: false })
    const created = await service.createPasskey("@alice")
    await service.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xa",
      pubkey: created.pubkey,
      prfSlot: created.prfSlot,
      isMskRoot: true,
    })
    service.clear()
    const err = await service.recoverPasskey({ credentialId: created.credentialId }).catch((e) => e)
    expect(err).toBeInstanceOf(NoPrfError)
    expect((err as { observed?: unknown }).observed).toEqual({
      credentialId: created.credentialId,
      attachment: "platform",
    })
  })

  it("a pinned answer with no PRF carries the observation too", async () => {
    const { service } = dualRoute({ prfAtAssert: false })
    const created = await service.createPasskey("@alice")
    await service.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xa",
      pubkey: created.pubkey,
      prfSlot: created.prfSlot,
      isMskRoot: true,
    })
    service.clear()
    const err = await service
      .adoptKnownPasskey({ credentialId: created.credentialId, pubkeyHex: created.pubkey })
      .catch((e) => e)
    expect(err).toBeInstanceOf(NoPrfError)
    expect((err as { observed?: unknown }).observed).toEqual({
      credentialId: created.credentialId,
      attachment: "platform",
    })
  })

  it("a rotated credential keeps its refusal", async () => {
    const { service } = dualRoute()
    const created = await service.createPasskey("@alice")
    await service.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xa",
      pubkey: created.pubkey,
      isMskRoot: false,
    })
    service.clear()
    await expect(
      service.recoverPasskey({ credentialId: created.credentialId }),
    ).rejects.toMatchObject({ name: "RotatedCredentialError" })
  })
})

describe("WebAlphaAuthService.unlock — verdicts and flights", () => {
  it("a divergent local answer refuses with wrong-key and observes platform", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = dualRoute({ divergent: true })
      const created = await service.createPasskey("@alice")
      await record(service, created, "0xacct")
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      service.clear()
      const err = await service.unlock(deriveFor(created, "0xacct")).catch((e) => e)
      expect(err).toBeInstanceOf(StoredAddressMismatchError)
      expect((err as { verdict?: string }).verdict).toBe("wrong-key")
      expect(await service.getSecretKey()).toBeUndefined()
    } finally {
      restore()
    }
  })

  it("an answer that came back cross-platform is not-reproduced", async () => {
    const restore = stubLocalStorage()
    try {
      const ceremony = new FakePasskeyCeremony({
        route: "cross-device",
        assertAttachment: "cross-platform",
      })
      const storage = new MemoryStorage()
      const service = new WebAlphaAuthService({
        storage,
        rpId: "localhost",
        ceremony,
        posture: () => "laptop",
      })
      const created = await service.createPasskey("@alice")
      await record(service, created, "0xacct")
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      service.clear()
      const err = await service.unlock(async () => "0xnope").catch((e) => e)
      expect(err).toBeInstanceOf(StoredAddressMismatchError)
      expect((err as { verdict?: string }).verdict).toBe("not-reproduced")
    } finally {
      restore()
    }
  })

  it("an answer that never evaluated the bound slot is not-reproduced", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = dualRoute({ divergent: true, secondSlot: false })
      const created = await service.createPasskey("@alice")
      await service.recordRecoveryMetadata({
        credentialId: created.credentialId,
        l2Address: "0xacct",
        pubkey: created.pubkey,
        prfSlot: "second",
        isMskRoot: true,
      })
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      service.clear()
      const err = await service.unlock(deriveFor(created, "0xacct")).catch((e) => e)
      expect(err).toBeInstanceOf(StoredAddressMismatchError)
      expect((err as { verdict?: string }).verdict).toBe("not-reproduced")
    } finally {
      restore()
    }
  })

  it("a key's transports learned by a cancelled attempt never reach the record", async () => {
    const restore = stubLocalStorage()
    try {
      const { withWebLock } = await import("../src/platform/storage/webLock")
      const { ceremony } = refusable(KEY)
      const storage = new MemoryStorage()
      const service = freshOver(ceremony, storage)
      const created = await service.createPasskey("@alice")
      // A record with no creation list, the shape a sign-in's inference is offered to.
      await service.recordRecoveryMetadata({
        credentialId: created.credentialId,
        l2Address: "0xacct",
        pubkey: created.pubkey,
        isMskRoot: true,
      })
      let release!: () => void
      const held = new Promise<void>((resolve) => (release = resolve))
      const holding = withWebLock("webwallet.passkey-identity-map", () => held)
      const ctrl = new AbortController()
      await service.recoverPasskey({ credentialId: created.credentialId, signal: ctrl.signal })
      ctrl.abort()
      release()
      await holding
      await flush()
      expect((await storedEntry(storage, created.credentialId)).inferredTransports).toBeUndefined()
    } finally {
      restore()
    }
  })

  it("a second unlock joins the live flight: one ceremony, one commit", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, ceremony } = dualRoute()
      const created = await service.createPasskey("@alice")
      await record(service, created, "0xacct")
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      service.clear()
      ceremony.assertRequests = []

      const assert = ceremony.assert.bind(ceremony)
      let release!: () => void
      vi.spyOn(ceremony, "assert").mockImplementationOnce(async (request) => {
        await new Promise<void>((resolve) => (release = resolve))
        return assert(request)
      })
      const a = service.unlock(deriveFor(created, "0xacct"))
      await flush()
      const b = service.unlock(deriveFor(created, "0xacct"))
      release()
      await Promise.all([a, b])
      expect(service.isUnlocked()).toBe(true)
      expect(ceremony.assertRequests).toHaveLength(1)
    } finally {
      restore()
    }
  })

  it("a second unlock after its owner aborted starts its own flight", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, ceremony } = dualRoute()
      const created = await service.createPasskey("@alice")
      await record(service, created, "0xacct")
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      service.clear()

      const assert = ceremony.assert.bind(ceremony)
      let releaseA!: () => void
      vi.spyOn(ceremony, "assert").mockImplementationOnce(async (request) => {
        await new Promise<void>((resolve) => (releaseA = resolve))
        return assert(request)
      })
      const ctrlA = new AbortController()
      const a = service
        .unlock(deriveFor(created, "0xacct"), { signal: ctrlA.signal })
        .catch((e) => e)
      await flush()
      ctrlA.abort()
      await service.unlock(deriveFor(created, "0xacct"))
      expect(service.isUnlocked()).toBe(true)
      releaseA()
      expect(await a).toBeInstanceOf(Error)
      expect((await service.getSecretKey())?.toString()).toBe(created.secretKey.toString())
    } finally {
      restore()
    }
  })
})

describe("WebAlphaAuthService attempt scope", () => {
  /** A scope that records what was asked through it, as the tracker's does for one attempt. */
  const scoping = () => {
    const asked: string[] = []
    const own: PasskeyRequestScope = (ceremony) => ({
      create: (request) => {
        asked.push("create")
        return ceremony.create(request)
      },
      assert: (request) => {
        asked.push("assert")
        return ceremony.assert(request)
      },
    })
    return { own, asked }
  }

  it("a creation asks through the attempt its status callback names, chained assertion included", async () => {
    // No key material at creation, so the driver chains an assertion for it.
    const { service } = laptop({ prfAtCreate: false })
    const { own, asked } = scoping()
    await service.createPasskey("@alice", statusForAttempt(own))
    expect(asked).toEqual(["create", "assert"])
  })

  it("a recovery and its second assertion ask through the attempt they were given", async () => {
    const { service } = laptop()
    const created = await service.createPasskey("@alice")
    const fresh = new WebAlphaAuthService({
      storage: new MemoryStorage(),
      rpId: "localhost",
      ceremony: (service as unknown as { ceremony: PasskeyCeremony }).ceremony,
      posture: () => "laptop",
    })
    const { own, asked } = scoping()
    const begun = await fresh.beginRecovery({ credentialId: created.credentialId, own })
    expect(isUnsettled(begun)).toBe(true)
    if (isUnsettled(begun)) await begun.settle()
    expect(asked).toEqual(["assert", "assert"])
  })

  it("an unlock asks through the attempt it was given", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = laptop(KEY)
      const created = await service.createPasskey("@alice")
      await service.recordRecoveryMetadata({
        credentialId: created.credentialId,
        l2Address: "0xacct",
        pubkey: created.pubkey,
        isMskRoot: true,
      })
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      service.clear()
      const { own, asked } = scoping()
      await service.unlock(deriveFor(created, "0xacct"), { own })
      expect(asked).toEqual(["assert"])
    } finally {
      restore()
    }
  })
})
