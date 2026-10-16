import { describe, expect, it, vi } from "vitest"
import { privateKeyToAccount } from "viem/accounts"
import { recoverAddress, type Hex, type PublicClient } from "viem"
import { encodeR1UserOpSignature, type AuthKeyEntry } from "@oxide/l1-contracts"
import { signMetadataConsent } from "../../src/oxide/metadataConsent"
import { toWebAuthnAuthArg } from "../../src/oxide/oxideWebAuthn"

const hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex
const bootstrap = privateKeyToAccount(hex(123))
const key = { qx: hex(1), qy: hex(2) }
const other = { qx: hex(1), qy: hex(3) }
function client(keys: AuthKeyEntry[]) {
  return {
    readContract: vi.fn(async ({ functionName }) =>
      functionName === "getAuthKeys" ? keys : bootstrap.address,
    ),
  } as unknown as PublicClient
}

describe("metadata consent authority", () => {
  it("signs the supplied digest directly while bootstrap is authorized", async () => {
    const digest = hex(42)
    const signature = await signMetadataConsent(
      { client: client([]), owner: bootstrap.address, bootstrap },
      digest,
    )
    expect(await recoverAddress({ hash: digest, signature })).toBe(bootstrap.address)
  })

  it("uses both coordinates and the installed index for a passkey", async () => {
    const assertion = {
      signature: `${hex(4)}${hex(5).slice(2)}`,
      webauthn: {
        authenticatorData: "0x0102",
        clientDataJSON: '{"type":"webauthn.get"}',
        challengeIndex: 23,
        typeIndex: 1,
      },
    }
    const signChallenge = vi.fn(async () => assertion)
    const signature = await signMetadataConsent(
      {
        client: client([
          { key: other, metadata: "0x" },
          { key, metadata: "0x" },
        ]),
        owner: bootstrap.address,
        bootstrap,
        passkey: { publicKey: key, signChallenge },
      },
      hex(42),
    )
    expect(signChallenge).toHaveBeenCalledWith(hex(42))
    expect(signature).toBe(encodeR1UserOpSignature(1n, toWebAuthnAuthArg(assertion)))
  })

  it("does not fall back to bootstrap after passkey installation", async () => {
    await expect(
      signMetadataConsent(
        { client: client([{ key, metadata: "0x" }]), owner: bootstrap.address, bootstrap },
        hex(42),
      ),
    ).rejects.toThrow("installed passkey")
  })

  it("does not fall back after a cancelled passkey ceremony", async () => {
    const signChallenge = vi.fn().mockRejectedValue(new Error("Cancelled"))
    await expect(
      signMetadataConsent(
        {
          client: client([{ key, metadata: "0x" }]),
          owner: bootstrap.address,
          bootstrap,
          passkey: { publicKey: key, signChallenge },
        },
        hex(42),
      ),
    ).rejects.toThrow("Cancelled")
  })
})
