// @vitest-environment node
/**
 * The deposit sync finds every flavor's sweeps by the commitment the portal indexes. Self-initiated
 * addresses commit to the self-resolver's `recipientHash`; the sync derives it with
 * `computeStealthRecipientHash`. Unmocked, they must agree.
 */
import { describe, expect, it } from "vitest"
import { Fr } from "@aztec/aztec.js/fields"
import { AztecAddress, EthAddress } from "@aztec/aztec.js/addresses"
import { SipaSelfResolver } from "@obsidion/sdk"
import { selfSipaResolverKeys } from "../../src/oxide/oxideAccountKeys"
import { computeStealthRecipientHash } from "../../src/core/services/deposits/sipa/stealth"

describe("SIPA recipient commitment", () => {
  it("is the same for the self-resolver and the deposit sync, with and without a given salt", async () => {
    const resolver = new SipaSelfResolver(selfSipaResolverKeys(new Fr(7n)))
    const user = AztecAddress.fromBigIntUnsafe(0xbeefn)
    const recovery = EthAddress.fromString("0x00000000000000000000000000000000000000c3")
    for (const salt of [undefined, new Fr(0x5a17n)]) {
      const resolution = await resolver.resolve(user, 3, 1, recovery, salt)
      const synced = await computeStealthRecipientHash(resolution.messageSecret, user)
      expect(synced.toString()).toBe(resolution.recipientHash.toString())
    }
  })
})
