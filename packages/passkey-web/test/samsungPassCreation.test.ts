/** Samsung Pass at sign-up, over the fake ceremony: admitted only on its own Android phone. */
import { describe, expect, it } from "vitest"
import { bytesToHex } from "../src/ceremony/bytes.js"
import type { DevicePosture } from "../src/browser/devicePosture.js"
import { type PasskeyCreationOptions, runPasskeyCreation } from "../src/drivers.js"
import { parseUserAgent } from "../src/browser/userAgentInfo.js"
import { UnsupportedProviderError } from "../src/refusals/passkeyErrors.js"
import { SAMSUNG_PASS_PHONE_COPY } from "../src/refusals/refusalCopy.js"
import { SAMSUNG_PASS_AAGUID, providerNameFor } from "../src/rules/passkeyProviders.js"
import { FakePasskeyCeremony, type FakeCeremonyOptions } from "./support/fakePasskeyCeremony.js"

const ANDROID = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko)"
const CHROME_ANDROID = parseUserAgent({
  userAgent: `${ANDROID} Chrome/155.0.0.0 Mobile Safari/537.36`,
  userAgentData: { platform: "Android", brands: [{ brand: "Google Chrome", version: "155" }] },
})
const SAMSUNG_INTERNET = parseUserAgent({
  userAgent: `${ANDROID} SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36`,
  userAgentData: {
    platform: "Android",
    brands: [{ brand: "Samsung Internet", version: "28.0" }],
  },
})
const FIREFOX_ANDROID = parseUserAgent({
  userAgent: "Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0",
})
const PROVIDER_NAME = providerNameFor(SAMSUNG_PASS_AAGUID)

// As measured on the phone: no PRF at creation, and the key on the read after it.
const samsungPass = (over: FakeCeremonyOptions = {}): FakeCeremonyOptions => ({
  manager: "1password",
  aaguid: SAMSUNG_PASS_AAGUID,
  prfAtCreate: false,
  ...over,
})

function create(
  posture: DevicePosture,
  fake: FakeCeremonyOptions,
  extra: Pick<PasskeyCreationOptions, "userAgent" | "localCreation"> = {},
) {
  const ceremony = new FakePasskeyCeremony(fake)
  const run = runPasskeyCreation(ceremony, {
    posture,
    rpId: "localhost",
    rpName: "zk.money",
    userName: "@alice",
    challengeForChained: () => new Uint8Array(32).fill(9),
    ...(extra.localCreation ? { attachmentLabelTrusted: true } : {}),
    ...extra,
  })
  return { ceremony, run }
}

describe("Samsung Pass at sign-up", () => {
  it("phone in any Android browser: binds second from the follow-up read", async () => {
    for (const userAgent of [CHROME_ANDROID, SAMSUNG_INTERNET, FIREFOX_ANDROID]) {
      const { ceremony, run } = create("phone", samsungPass({ route: "local" }), { userAgent })
      const result = await run
      expect(result.slot).toBe("second")
      expect(result.chained).toBeDefined()
      const id = result.created.credentialId
      expect(bytesToHex(result.prfOutput)).toBe(bytesToHex(ceremony.prfFor(id, "second")))
    }
  })

  it("is refused over QR before the follow-up read, pointing at the phone", async () => {
    const { ceremony, run } = create("laptop", samsungPass({ route: "cross-device" }))
    const err = await run.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UnsupportedProviderError)
    expect(err).toMatchObject({ providerName: PROVIDER_NAME, advice: SAMSUNG_PASS_PHONE_COPY })
    expect(ceremony.assertRequests).toHaveLength(0)
  })

  it("keeps the backup gate: a passkey that cannot be backed up is refused", async () => {
    const { run } = create("phone", samsungPass({ route: "local", backupEligible: false }), {
      userAgent: SAMSUNG_INTERNET,
    })
    await expect(run).rejects.toThrow(expect.objectContaining({ name: "DeviceBoundPasskeyError" }))
  })

  it("is refused on a phone whose browser made no claims, before the follow-up read", async () => {
    const { ceremony, run } = create("phone", samsungPass({ route: "local" }))
    const err = await run.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UnsupportedProviderError)
    expect(err).toMatchObject({ providerName: PROVIDER_NAME })
    expect((err as UnsupportedProviderError).advice).toBeUndefined()
    expect(ceremony.assertRequests).toHaveLength(0)
  })

  it("is refused as a laptop's own passkey, without the phone advice", async () => {
    const { run } = create("laptop", samsungPass({ route: "local" }), {
      localCreation: { managers: ["gpm", "1password"] },
    })
    const err = await run.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UnsupportedProviderError)
    expect(err).toMatchObject({ providerName: PROVIDER_NAME })
    expect((err as UnsupportedProviderError).advice).toBeUndefined()
  })
})
