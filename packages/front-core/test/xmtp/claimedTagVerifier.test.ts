import { describe, expect, it } from "vitest"

import {
  TagValidationError,
  type RegistryTagResolution,
} from "../../src/core/services/RegistryTagResolver"
import { createClaimedTagVerifier } from "../../src/xmtp/tagForwardResolver"

const SENDER = "0xAbCdef0000000000000000000000000000001234"
const INBOX_KEY = "0x" + "33".repeat(20)
const L2 = "0x" + "11".repeat(32)

function resolved(
  over: Partial<Extract<RegistryTagResolution, { status: "resolved" }>> = {},
): RegistryTagResolution {
  return {
    status: "resolved",
    account: "0x00000000000000000000000000000000000000aa",
    l2Address: L2,
    rollupId: "aztec-dev",
    sipaStealthPublicKey: { x: 1n, y: 2n },
    xmtpAddress: SENDER,
    ...over,
  }
}

describe("createClaimedTagVerifier", () => {
  it("accepts a tag whose bootstrap address is anywhere on the sender's inbox", async () => {
    const verify = createClaimedTagVerifier(async () => resolved())
    expect(await verify("Bob", [SENDER.toLowerCase()])).toEqual({ tag: "bob", l2: L2 })
    expect(await verify("Bob", [INBOX_KEY, SENDER])).toEqual({ tag: "bob", l2: L2 })
  })

  it("returns null for a mismatch, an unresolvable peer, or unknown tag", async () => {
    const mismatch = createClaimedTagVerifier(async () =>
      resolved({ xmtpAddress: "0x" + "22".repeat(20) }),
    )
    expect(await mismatch("bob", [SENDER, INBOX_KEY])).toBeNull()

    const noPeer = createClaimedTagVerifier(async () => resolved())
    expect(await noPeer("bob", [])).toBeNull()

    const missing = createClaimedTagVerifier(async () => ({ status: "notFound" }))
    expect(await missing("ghost", [SENDER])).toBeNull()
  })

  it("maps TagValidationError to null and rethrows transport failures", async () => {
    const invalid = createClaimedTagVerifier(async () => {
      throw new TagValidationError("bad tag")
    })
    expect(await invalid("BAD!", [SENDER])).toBeNull()

    const down = createClaimedTagVerifier(async () => {
      throw new Error("registry unreachable")
    })
    await expect(down("bob", [SENDER])).rejects.toThrow("registry unreachable")
  })
})
