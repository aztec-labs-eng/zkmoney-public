// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { testPage, pageOver, testCore } from "../../../support/page"
import { WebAlphaAuthService } from "../../../../src/platform/auth/WebAlphaAuthService"
import { FakePasskeyCeremony } from "../../../support/fakePasskeyCeremony"

const ICLOUD = "fbfc3007-154e-4ecc-8c0b-6e020557d7bd"
const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"

function stubBrowser(navigatorExtras: Record<string, unknown> = {}) {
  vi.stubGlobal("navigator", { userAgent: MAC_SAFARI, ...navigatorExtras })
}

/** Lets the record's Client Hints read settle, then waits for its write to commit. */
const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await testCore().database.write(async () => {})
}
const last = () => testCore().device.get().passkeyEnv

function laptop(ceremony: FakePasskeyCeremony, storage = testPage().database) {
  return new WebAlphaAuthService({
    ...pageOver(storage),
    rpId: "localhost",
    ceremony,
    posture: () => "laptop",
  })
}

describe("passkey environment collection in the auth service", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("keeps the label the browser reported even when the driver corrects it", async () => {
    stubBrowser()
    const ceremony = new FakePasskeyCeremony({
      route: "cross-device",
      aaguid: ICLOUD,
      transports: ["hybrid", "internal"],
      attachment: "platform",
    })
    const service = new WebAlphaAuthService({
      ...pageOver(testPage().database),
      rpId: "localhost",
      ceremony,
      posture: () => "laptop",
      misreportsCrossDevice: () => true,
    })
    const created = await service.createPasskey("@alice")
    await flush()
    expect(created.prfSlot).toBe("first")
    expect(last()?.attachment).toBe("platform")
    expect(last()?.transports).toEqual(["hybrid", "internal"])
    // A sign-in that follows keeps what the creation reported.
    await service.recoverPasskey({ credentialId: created.credentialId })
    await flush()
    expect(last()?.attachment).toBe("platform")
  })

  it("a creation that needs the chained assertion still records the creation's manager id", async () => {
    stubBrowser()
    const ceremony = new FakePasskeyCeremony({
      route: "cross-device",
      aaguid: ICLOUD,
      prfAtCreate: false,
    })
    const created = await laptop(ceremony).createPasskey("@alice")
    await flush()
    expect(ceremony.assertRequests).toHaveLength(1)
    expect(created.prfAaguid).toBe(ICLOUD)
    expect(last()?.aaguid).toBe(ICLOUD)
  })

  it("an unlock takes the manager id from the credential's record, or reports unknown", async () => {
    stubBrowser()
    const ceremony = new FakePasskeyCeremony({ route: "cross-device", aaguid: ICLOUD })
    const service = laptop(ceremony)
    const created = await service.createPasskey("@alice")
    await service.recoverPasskey({ credentialId: created.credentialId })
    await flush()
    expect(last()?.aaguid).toBe("unknown")

    await service.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xabc",
      pubkey: created.pubkey,
      prfSlot: created.prfSlot,
      prfAaguid: created.prfAaguid,
      isMskRoot: true,
    })
    await service.recoverPasskey({ credentialId: created.credentialId })
    await flush()
    expect(last()?.aaguid).toBe(ICLOUD)
  })

  it("a Client Hints answer that never settles does not hold the ceremony", async () => {
    stubBrowser({
      userAgentData: { mobile: false, getHighEntropyValues: () => new Promise(() => {}) },
    })
    const ceremony = new FakePasskeyCeremony({ route: "cross-device", aaguid: ICLOUD })
    const service = laptop(ceremony)
    const created = await service.createPasskey("@alice")
    expect(created.prfSlot).toBe("first")
    await expect(
      service.recoverPasskey({ credentialId: created.credentialId }),
    ).resolves.toMatchObject({
      credentialId: created.credentialId,
    })
    expect(last()).toBeNull()
  })
})
