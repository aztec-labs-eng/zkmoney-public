// @vitest-environment node
import { GPM_AAGUID, ZERO_AAGUID } from "@obsidion/core/constants"
import { CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID, passkeyWritten } from "@obsidion/passkey-web"
import { describe, expect, it } from "vitest"
import { WebAlphaAuthService } from "../src/platform/auth/WebAlphaAuthService"
import {
  FakePasskeyCeremony,
  type FakeCeremonyOptions,
  MemoryStorage,
} from "./support/fakePasskeyCeremony"

/** Outside the measured set; the name table knows Bitwarden's but not this one. */
const UNMEASURED = "0f0f0f0f-0f0f-0f0f-0f0f-0f0f0f0f0f0f"
const BITWARDEN = "d548826e-79b4-db40-a3d8-11116f7e8349"

function laptop(fake: FakeCeremonyOptions, extraProviders?: readonly string[]) {
  const ceremony = new FakePasskeyCeremony({ route: "cross-device", ...fake })
  const service = new WebAlphaAuthService({
    storage: new MemoryStorage(),
    rpId: "localhost",
    ceremony,
    posture: () => "laptop",
    extraProviders,
  })
  return { service, ceremony }
}

describe("creation admits only the measured providers", () => {
  it("names the manager, records nothing, and issues no follow-up assertion", async () => {
    const { service, ceremony } = laptop({ aaguid: BITWARDEN })
    await expect(service.createPasskey("@alice")).rejects.toMatchObject({
      name: "UnsupportedProviderError",
      providerName: "Bitwarden",
    })
    expect(ceremony.assertRequests).toHaveLength(0)
    expect(await service.rootCredentialId()).toBeUndefined()
    // The refusal leaves the service as the driver threw it: marked as written.
    const refused = await service.createPasskey("@alice").catch((e: unknown) => e)
    expect(passkeyWritten(refused)).toBe(true)
  })

  it("refuses before the chained assertion even when creation returned no key material", async () => {
    const { service, ceremony } = laptop({ aaguid: UNMEASURED, prfAtCreate: false })
    await expect(service.createPasskey("@alice")).rejects.toMatchObject({
      name: "UnsupportedProviderError",
    })
    expect(ceremony.assertRequests).toHaveLength(0)
  })

  it("admits a measured manager, an all-zero id and an absent one", async () => {
    await expect(laptop({ aaguid: GPM_AAGUID }).service.createPasskey("@a")).resolves.toMatchObject(
      { prfAaguid: GPM_AAGUID, prfSlot: "first" },
    )
    // The fake echoes whatever id it is given; the real wrapper reports zeros as no id at all.
    // Either way the allowlist admits it, which is what this pins.
    await expect(
      laptop({ aaguid: ZERO_AAGUID }).service.createPasskey("@a"),
    ).resolves.toMatchObject({ prfAaguid: ZERO_AAGUID, prfSlot: "first" })
    await expect(laptop({}).service.createPasskey("@a")).resolves.toMatchObject({
      prfAaguid: undefined,
      prfSlot: "first",
    })
  })

  it("admits the browser-test authenticator only when the build passes its id", async () => {
    const fake = { aaguid: CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID }
    await expect(laptop(fake).service.createPasskey("@a")).rejects.toMatchObject({
      name: "UnsupportedProviderError",
    })
    const seeded = laptop(fake, [CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID])
    await expect(seeded.service.createPasskey("@a")).resolves.toMatchObject({
      prfAaguid: CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID,
      prfSlot: "first",
    })
  })
})
