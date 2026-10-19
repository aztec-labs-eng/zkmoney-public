import { describe, expect, it, vi } from "vitest"

vi.mock("@oxide/oxide-lib/refund_authorization.js", async (original) => ({
  ...(await original<typeof import("@oxide/oxide-lib/refund_authorization.js")>()),
  deriveRefundOwnerAddress: async () => ACCOUNT,
}))

import { Fr } from "@aztec/aztec.js/fields"
import { WebAuthnAlphaAuthProvider } from "../../src/obsidion/alpha/auth/WebAuthnAlphaAuthProvider.js"
import { passkeyRefundOwner } from "../../src/services/FrozenRefundMigrationRuntime.js"

const ACCOUNT = { equals: () => true }

describe("a frozen refund's passkey owner", () => {
  it("signs through the host's signer, so a saved approval can stand in", async () => {
    const prompt = vi.fn(async () => ({
      signature: new Uint8Array(64),
      authenticatorData: new Uint8Array(37),
      clientDataJSON: new Uint8Array([123, 125]),
    }))
    const auth = new WebAuthnAlphaAuthProvider(Buffer.alloc(32, 1), Buffer.alloc(32, 2), prompt)
    const account = { getAuthProvider: () => auth, getAddress: () => ACCOUNT }
    const wallet = {
      pxe: {
        getContractInstance: async () => ({
          publicKeys: {},
          originalContractClassId: Fr.ZERO,
          salt: Fr.ZERO,
          initializationHash: Fr.ZERO,
          deployer: ACCOUNT,
        }),
      },
    }
    const saved = vi.fn(async () => ({
      signature: new Uint8Array(64).fill(9),
      authenticatorData: new Uint8Array(37),
      clientDataJSON: new Uint8Array([123, 125]),
    }))

    const owner = await passkeyRefundOwner(wallet as never, account as never, () => saved)
    if (owner.authorizer.kind !== "passkey") throw new Error("expected a passkey owner")
    const signed = await owner.authorizer.signer.sign(new Fr(5n))

    expect(saved).toHaveBeenCalledWith(new Fr(5n).toBuffer())
    expect(prompt).not.toHaveBeenCalled()
    expect(signed.signature[0]).toBe(9)
  })
})
