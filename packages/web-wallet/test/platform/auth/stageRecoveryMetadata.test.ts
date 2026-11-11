/** Several records staged in one write keep what this page's creation of each passkey knew. */
import { bytesToBase64Url } from "@obsidion/passkey-web"
import { describe, expect, it } from "vitest"
import { WebPasskeyIdentityMap } from "../../../src/platform/auth/WebPasskeyIdentityMap"
import { FakePasskeyCeremony } from "../../support/fakePasskeyCeremony"
import { testAuth, testCore } from "../../support/page"

describe("stageRecoveryMetadata", () => {
  it("records each passkey with its creation's handle and security-key mark, and only its own", async () => {
    // A YubiKey, answered over USB from a laptop.
    const ceremony = new FakePasskeyCeremony({
      route: "cross-device",
      manager: "security-key",
      transports: ["usb"],
      backupEligible: false,
    })
    const service = testAuth({ ceremony, posture: () => "laptop" })
    const created = await service.createPasskey("alice")
    const meta = { l2Address: "0xabc", isMskRoot: true }

    await testCore().database.write((w) =>
      service.stageRecoveryMetadata(w, [
        { ...meta, credentialId: created.credentialId, pubkey: created.pubkey },
        { ...meta, credentialId: "elsewhere", pubkey: "cd".repeat(64) },
      ]),
    )

    const map = new WebPasskeyIdentityMap(testCore().database, "localhost")
    const handle = bytesToBase64Url(ceremony.creds.get(created.credentialId)!.handle)
    expect(await map.get(created.credentialId)).toMatchObject({
      userHandle: handle,
      securityKey: true,
      backupEligible: false,
    })
    const other = await map.get("elsewhere")
    expect(other?.userHandle).toBeUndefined()
    expect(other?.securityKey).toBeUndefined()
  })
})
