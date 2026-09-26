// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebAlphaAuthService } from "../src/platform/auth/WebAlphaAuthService"
import { setActiveCredentialId } from "../src/platform/storage/activeStorage"
import { FakePasskeyCeremony, MemoryStorage } from "./support/fakePasskeyCeremony"

function laptop(laptopHints?: null) {
  const ceremony = new FakePasskeyCeremony({ route: "cross-device" })
  const service = new WebAlphaAuthService({
    storage: new MemoryStorage(),
    rpId: "localhost",
    ceremony,
    posture: () => "laptop",
    ...(laptopHints === null ? { laptopHints: null } : {}),
  })
  return { service, ceremony }
}

function phone() {
  const ceremony = new FakePasskeyCeremony({ route: "local" })
  const service = new WebAlphaAuthService({
    storage: new MemoryStorage(),
    rpId: "localhost",
    ceremony,
    posture: () => "phone",
  })
  return { service, ceremony }
}

describe("recoverPasskey requests", () => {
  it("names the recorded root by default and leaves the list open for the chooser", async () => {
    const { service, ceremony } = laptop()
    const created = await service.createPasskey("@alice")
    await service.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xabc",
      pubkey: created.pubkey,
      prfSlot: created.prfSlot,
      isMskRoot: true,
    })
    await service.recoverPasskey({})
    expect(ceremony.asserts.at(-1)).toEqual([created.credentialId])
    await service.recoverPasskey({ discover: true })
    expect(ceremony.asserts.at(-1)).toBeUndefined()
    await service.recoverPasskey({ credentialId: created.credentialId })
    expect(ceremony.asserts.at(-1)).toEqual([created.credentialId])
  })

  it("a stale recorded root is not pinned, so a different credential can answer", async () => {
    const { service, ceremony } = laptop()
    // A: this browser's recorded root, but its passkey is no longer on the device.
    const a = await service.createPasskey("@alice")
    await service.recordRecoveryMetadata({
      credentialId: a.credentialId,
      l2Address: "0xabc",
      pubkey: a.pubkey,
      prfSlot: a.prfSlot,
      isMskRoot: true,
    })
    // B: the passkey actually present, with no local record for it.
    const b = await service.createPasskey("@bob")
    ceremony.creds.delete(a.credentialId)
    ceremony.asserts.length = 0

    // A laptop /enter is discoverable, so the request names no credential — the stale root A is not
    // pinned — and B answers. B has no record here, so a second assertion pinned to B recovers its
    // public key. The recovered identity is B's, never A's.
    const recovered = await service.recoverPasskey({ discover: true })
    expect(ceremony.asserts[0]).toBeUndefined()
    expect(ceremony.asserts[1]).toEqual([b.credentialId])
    expect(recovered.credentialId).toBe(b.credentialId)
  })

  it("a phone keeps the pin: the request it issues names the recorded root", async () => {
    const { service, ceremony } = phone()
    const a = await service.createPasskey("@alice")
    await service.recordRecoveryMetadata({
      credentialId: a.credentialId,
      l2Address: "0xabc",
      pubkey: a.pubkey,
      prfSlot: a.prfSlot,
      isMskRoot: true,
    })
    ceremony.asserts.length = 0
    // The phone /enter path (and the reuse callers) send no `discover`, so the ceremony pins the
    // recorded root and goes straight to the local authenticator.
    await service.recoverPasskey({ credentialId: undefined })
    expect(ceremony.asserts[0]).toEqual([a.credentialId])
  })

  it("a laptop admits its own on-device answer to a discoverable request", async () => {
    const ceremony = new FakePasskeyCeremony({ route: "cross-device", assertAttachment: "platform" })
    const service = new WebAlphaAuthService({
      storage: new MemoryStorage(),
      rpId: "localhost",
      ceremony,
      posture: () => "laptop",
    })
    const created = await service.createPasskey("@alice")
    // The browser's own chooser decides which device answers; a `platform` answer (this computer's
    // synced copy) is accepted, the anchors settle it.
    const recovered = await service.recoverPasskey({ discover: true })
    expect(recovered.credentialId).toBe(created.credentialId)
  })
})

describe("typed session errors", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("unlock without a record for the active credential is a NoPasskeySessionError", async () => {
    const map = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    })
    const { service } = laptop()
    setActiveCredentialId("nobody")
    await expect(service.unlock(async () => "0x1")).rejects.toMatchObject({
      name: "NoPasskeySessionError",
    })
  })
})

describe("probePhoneReach on the service", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("is unknown under the e2e seam and answers the browser otherwise", async () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    })
    vi.stubGlobal("PublicKeyCredential", {
      getClientCapabilities: () => Promise.resolve({ hybridTransport: false }),
    })
    expect(await laptop(null).service.probePhoneReach()).toBe("unknown")
    expect(await laptop().service.probePhoneReach()).toBe("no-hybrid")
  })
})
