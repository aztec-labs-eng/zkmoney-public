import { describe, expect, it, vi } from "vitest"

const { assertRefundOwner } = vi.hoisted(() => ({ assertRefundOwner: vi.fn(async () => {}) }))
vi.mock("@oxide/oxide-client/sign_migration.js", async (original) => ({
  ...(await original<typeof import("@oxide/oxide-client/sign_migration.js")>()),
  assertRefundOwner,
}))

import { Fr } from "@aztec-labs/aztec.js/fields"
import { WebAuthnAlphaAuthProvider } from "../../src/obsidion/alpha/auth/WebAuthnAlphaAuthProvider.js"
import { passkeyRefundOwner } from "../../src/services/FrozenRefundMigrationRuntime.js"

const ACCOUNT = { equals: () => true }

const sign = async () => ({
  signature: new Uint8Array(64),
  authenticatorData: new Uint8Array(37),
  clientDataJSON: new Uint8Array([123, 125]),
})

function fixture(auth: WebAuthnAlphaAuthProvider) {
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
  return { account: account as never, wallet: wallet as never }
}

describe("a frozen refund's passkey owner", () => {
  it("signs through the host's signer, so a saved approval can stand in", async () => {
    const prompt = vi.fn(sign)
    const auth = new WebAuthnAlphaAuthProvider(Buffer.alloc(32, 1), Buffer.alloc(32, 2), prompt)
    const { account, wallet } = fixture(auth)
    const saved = vi.fn(async () => ({ ...(await sign()), signature: new Uint8Array(64).fill(9) }))

    const owner = await passkeyRefundOwner(wallet, account, () => saved)
    if (owner.signer.kind !== "passkey") throw new Error("expected a passkey owner")
    const signed = await owner.signer.passkeySigner.sign(new Fr(5n))

    expect(saved).toHaveBeenCalledWith(new Fr(5n).toBuffer())
    expect(prompt).not.toHaveBeenCalled()
    expect(signed.signature[0]).toBe(9)
  })

  it("carries the provider's passkey set and is checked as the refund owner", async () => {
    const other = Buffer.concat([Buffer.alloc(32, 3), Buffer.alloc(32, 4)]).toString("hex")
    const own = Buffer.concat([Buffer.alloc(32, 1), Buffer.alloc(32, 2)]).toString("hex")
    const auth = new WebAuthnAlphaAuthProvider(Buffer.alloc(32, 1), Buffer.alloc(32, 2), sign, [
      other,
      own,
    ])
    const { account, wallet } = fixture(auth)

    const owner = await passkeyRefundOwner(wallet, account)
    if (owner.signer.kind !== "passkey") throw new Error("expected a passkey owner")
    const { slots } = await auth.getPasskeySet()
    expect(owner.signer.passkeySet.map((s) => s.toString())).toEqual(
      slots.map((s) => s.toString()),
    )
    expect(owner.signer.passkeySet.filter((s) => !s.isZero())).toHaveLength(2)
    expect(assertRefundOwner).toHaveBeenCalledWith(owner)
  })

  it("propagates a refused owner", async () => {
    const auth = new WebAuthnAlphaAuthProvider(Buffer.alloc(32, 1), Buffer.alloc(32, 2), sign)
    const { account, wallet } = fixture(auth)
    assertRefundOwner.mockRejectedValueOnce(new Error("not this account"))
    await expect(passkeyRefundOwner(wallet, account)).rejects.toThrow(/not this account/)
  })
})
