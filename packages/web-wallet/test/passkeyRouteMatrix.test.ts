/**
 * The route × manager matrix behind the slot rule. Device guess, actual route (which sets the
 * attachment the browser reports) and manager are independent axes. For every manager, an account
 * created over either route must be recovered over either route by an address anchor, and the
 * cells the policy refuses must refuse. Expected PRF values come from the fake's own model, which
 * hashes with its own SHA-256 rather than the sdk's `contextualize`, and the salt fixtures are
 * pinned so a change to the production salt or helper fails here rather than cancelling out.
 */
// @vitest-environment node
import { Fr } from "@aztec/aztec.js/fields"
import { selectRecoveredMsk } from "@obsidion/front-core"
import { MSK_PRF_SALT, contextualize } from "@obsidion/sdk"
import { describe, expect, it } from "vitest"
import { WebAlphaAuthService } from "../src/platform/auth/WebAlphaAuthService"
import type { DevicePosture } from "@obsidion/passkey-web"
import {
  FakePasskeyCeremony,
  type FakeManager,
  type FakeRoute,
  MemoryStorage,
  contextualiseLocal,
} from "./support/fakePasskeyCeremony"

const MANAGERS: FakeManager[] = ["icloud", "1password", "gpm"]
const ROUTES: FakeRoute[] = ["local", "cross-device"]
const postureFor = (route: FakeRoute): DevicePosture => (route === "local" ? "phone" : "laptop")

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex")

/** A wallet address derivation the tests can predict: the master key itself. */
const deriveAddress = async (msk: Fr) => msk.toString()

function service(ceremony: FakePasskeyCeremony, posture: DevicePosture) {
  return new WebAlphaAuthService({
    storage: new MemoryStorage(),
    rpId: "localhost",
    ceremony,
    posture: () => posture,
  })
}

describe("salt fixtures", () => {
  it("the wallet salt and its contextualisations are the pinned values", async () => {
    expect(hex(MSK_PRF_SALT)).toBe(
      "a8e51261f6a147fd70b4506ac31275c61255aa4054b8fb72c169a180242fbbc6",
    )
    // K(S), what production sends as the second salt, and K(K(S)), what a browser hands a
    // cross-device authenticator for it: both by the test's own SHA-256, both pinned.
    const kS = contextualiseLocal(MSK_PRF_SALT)
    expect(hex(kS)).toBe("f3b0ab00f476a660bca5ad4dcd937f5231a82ba7959cfc660c51e09fe5fb063a")
    expect(hex(await contextualize(MSK_PRF_SALT))).toBe(hex(kS))
    expect(hex(contextualiseLocal(kS))).toBe(
      "28b33cb8cc40f1329bcc69334245ab70e24ed8282ea4121b6e4d2bebbff1455c",
    )
  })
})

describe("route × manager: an account created on one route opens on the other", () => {
  for (const manager of MANAGERS) {
    for (const createRoute of ROUTES) {
      for (const readRoute of ROUTES) {
        it(`${manager}: created over ${createRoute}, recovered over ${readRoute}`, async () => {
          const ceremony = new FakePasskeyCeremony({ manager, route: createRoute })
          const creator = service(ceremony, postureFor(createRoute))
          const created = await creator.createPasskey("@alice")
          const address = await deriveAddress(created.secretKey)

          // A browser holding the record: the stored address is the anchor.
          ceremony.opts.route = readRoute
          const reader = service(ceremony, postureFor(readRoute))
          await reader.recordRecoveryMetadata({
            credentialId: created.credentialId,
            l2Address: address,
            pubkey: created.pubkey,
            prfSlot: created.prfSlot,
            isMskRoot: true,
          })
          const recovered = await reader.recoverPasskey({ credentialId: created.credentialId })
          const candidates = [recovered.candidates.first, recovered.candidates.second]
            .filter((c): c is Fr => c !== undefined)
            .map((c) => c.toString())
          expect(candidates).toContain(address)
          // The stored address picks that candidate out of the pair, whatever slot it sits in.
          const picked = await selectRecoveredMsk(recovered, deriveAddress)
          expect(picked.toString()).toBe(created.secretKey.toString())
        })
      }
    }
  }
})

describe("a security key: created on one device kind, recovered on the other", () => {
  // A key is another device's answer on either posture, so the posture is chosen independently of
  // the route rather than derived from it. It holds the only copy, hence no backup.
  const POSTURES: DevicePosture[] = ["phone", "laptop"]
  const keyCeremony = (over = {}) =>
    new FakePasskeyCeremony({
      manager: "security-key",
      route: "cross-device",
      transports: ["usb"],
      backupEligible: false,
      ...over,
    })

  for (const createOn of POSTURES) {
    for (const readOn of POSTURES) {
      for (const [label, over] of [
        ["answering at creation", {}],
        ["answering on the chained assertion", { prfAtCreate: false }],
      ] as const) {
        it(`created on a ${createOn}, recovered on a ${readOn}, ${label}`, async () => {
          const ceremony = keyCeremony(over)
          const created = await service(ceremony, createOn).createPasskey("@alice")
          expect(created.prfSlot).toBe("first")
          // Pin the bytes, not just the label: recovery tries both candidates, so a run that
          // bound the second output while calling it "first" would still round-trip.
          expect(created.secretKey.toString()).toBe(
            Fr.fromBufferReduce(
              Buffer.from(ceremony.prfFor(created.credentialId, "first")),
            ).toString(),
          )
          const address = await deriveAddress(created.secretKey)

          const reader = service(ceremony, readOn)
          await reader.recordRecoveryMetadata({
            credentialId: created.credentialId,
            l2Address: address,
            pubkey: created.pubkey,
            prfSlot: created.prfSlot,
            isMskRoot: true,
          })
          const recovered = await reader.recoverPasskey({ credentialId: created.credentialId })
          const picked = await selectRecoveredMsk(recovered, deriveAddress)
          expect(picked.toString()).toBe(created.secretKey.toString())
        })
      }
    }
  }
})

describe("route × manager: refusals", () => {
  it("laptop posture answered locally refuses", async () => {
    const ceremony = new FakePasskeyCeremony({ manager: "icloud", route: "local" })
    await expect(service(ceremony, "laptop").createPasskey("@a")).rejects.toMatchObject({
      name: "PhoneRequiredError",
    })
  })

  it("phone posture answered by another phone over QR refuses", async () => {
    // Cross-device, but no physical transports, so it is another phone rather than a key.
    const ceremony = new FakePasskeyCeremony({ manager: "gpm", route: "cross-device" })
    await expect(service(ceremony, "phone").createPasskey("@a")).rejects.toMatchObject({
      name: "LocalPasskeyRequiredError",
    })
  })

  it("a local provider returning only the first slot refuses", async () => {
    const ceremony = new FakePasskeyCeremony({
      manager: "1password",
      route: "local",
      secondSlot: false,
    })
    await expect(service(ceremony, "phone").createPasskey("@a")).rejects.toMatchObject({
      name: "SingleSaltProviderError",
    })
  })

  it("no PRF on either ceremony refuses", async () => {
    const ceremony = new FakePasskeyCeremony({
      prfAtCreate: false,
      prfAtAssert: false,
      route: "cross-device",
    })
    await expect(service(ceremony, "laptop").createPasskey("@a")).rejects.toMatchObject({
      name: "NoPrfError",
    })
  })
})

describe("the slot rule is keyed on the response, not the device guess", () => {
  it("a cross-device answer binds to slot first even though nothing about the device changed", async () => {
    const ceremony = new FakePasskeyCeremony({ manager: "1password", route: "cross-device" })
    const created = await service(ceremony, "laptop").createPasskey("@a")
    expect(created.prfSlot).toBe("first")
    // The same value is what the 1Password phone returns locally in its second slot.
    expect(created.secretKey.toString()).toBe(
      Fr.fromBufferReduce(
        Buffer.from(ceremony.prfFor(created.credentialId, "second", "local")),
      ).toString(),
    )
  })
})
