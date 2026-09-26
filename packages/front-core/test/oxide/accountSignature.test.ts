import { describe, expect, it, vi } from "vitest"
import { accountPersonalSignHash } from "@oxide/l1-contracts"
import { privateKeyToAccount } from "viem/accounts"
import { recoverAddress, type Hex } from "viem"
import { signAccountDigest, signAccountDigestWithPasskey } from "../../src/oxide/accountSignature"

const bootstrap = privateKeyToAccount(`0x${"42".repeat(32)}`)
const account = "0x2222222222222222222222222222222222222222"
const hash = `0x${"33".repeat(32)}` as Hex
const chainId = 31337
const key = { qx: `0x${"01".repeat(32)}` as Hex, qy: `0x${"02".repeat(32)}` as Hex }
const auth = {
  r: `0x${"03".repeat(32)}` as Hex,
  s: `0x${"04".repeat(32)}` as Hex,
  challengeIndex: 1n,
  typeIndex: 2n,
  authenticatorData: "0x" as Hex,
  clientDataJSON: "{}",
}

describe("account signatures", () => {
  it.each(["0x", "0x01"])(
    "wraps bootstrap consent when the account has no passkeys (code=%s)",
    async (code) => {
      const signature = await signAccountDigest({
        account,
        hash,
        chainId,
        bootstrap,
        reader: { getCode: async () => code as Hex, readAuthKeys: async () => [] },
      })
      expect(
        await recoverAddress({ hash: accountPersonalSignHash(account, chainId, hash), signature }),
      ).toBe(bootstrap.address)
      expect(await recoverAddress({ hash, signature })).not.toBe(bootstrap.address)
    },
  )

  it("uses the matching installed passkey index and wrapped challenge", async () => {
    const sign = vi.fn(async () => auth)
    const signature = await signAccountDigest({
      account,
      hash,
      chainId,
      bootstrap,
      passkey: { key, sign },
      reader: {
        getCode: async () => "0x01",
        readAuthKeys: async () => [
          { key: { ...key, qx: auth.r }, metadata: "0x" },
          { key, metadata: "0x" },
        ],
      },
    })
    expect(BigInt(signature.slice(0, 66))).toBe(1n)
    expect(sign).toHaveBeenCalledWith(accountPersonalSignHash(account, chainId, hash))
  })

  it("refuses a bootstrap fallback when another passkey is installed", async () => {
    const sign = vi.fn(async () => auth)
    await expect(
      signAccountDigest({
        account,
        hash,
        chainId,
        bootstrap,
        passkey: { key, sign },
        reader: {
          getCode: async () => "0x01",
          readAuthKeys: async () => [{ key: { ...key, qx: auth.r }, metadata: "0x" }],
        },
      }),
    ).rejects.toThrow("not installed")
    expect(sign).not.toHaveBeenCalled()
  })

  it("propagates a failed account read before signing", async () => {
    const sign = vi.fn(async () => auth)
    await expect(
      signAccountDigest({
        account,
        hash,
        chainId,
        bootstrap,
        passkey: { key, sign },
        reader: {
          getCode: async () => {
            throw new Error("RPC failed")
          },
          readAuthKeys: async () => [],
        },
      }),
    ).rejects.toThrow("RPC failed")
    expect(sign).not.toHaveBeenCalled()
  })
})

describe("passkey-only account signatures", () => {
  const installed = (keys: { key: typeof key; metadata: Hex }[]) => ({
    getCode: async () => "0x01" as Hex,
    readAuthKeys: async () => keys,
  })

  it.each(["0x", "0x01"])(
    "refuses an account with no installed passkey (code=%s)",
    async (code) => {
      const sign = vi.fn(async () => auth)
      await expect(
        signAccountDigestWithPasskey({
          account,
          hash,
          chainId,
          passkey: { key, sign },
          reader: { getCode: async () => code as Hex, readAuthKeys: async () => [] },
        }),
      ).rejects.toThrow("Finish setting up your account's passkey, then try again")
      expect(sign).not.toHaveBeenCalled()
    },
  )

  it("signs the wrapped challenge with the matching installed passkey index", async () => {
    const sign = vi.fn(async () => auth)
    const signature = await signAccountDigestWithPasskey({
      account,
      hash,
      chainId,
      passkey: { key, sign },
      reader: installed([
        { key: { ...key, qx: auth.r }, metadata: "0x" },
        { key, metadata: "0x" },
      ]),
    })
    expect(BigInt(signature.slice(0, 66))).toBe(1n)
    expect(sign).toHaveBeenCalledWith(accountPersonalSignHash(account, chainId, hash))
  })

  it("refuses a missing or uninstalled passkey", async () => {
    const sign = vi.fn(async () => auth)
    const reader = installed([{ key: { ...key, qx: auth.r }, metadata: "0x" }])
    await expect(signAccountDigestWithPasskey({ account, hash, chainId, reader })).rejects.toThrow(
      "Unlock the installed account passkey",
    )
    await expect(
      signAccountDigestWithPasskey({ account, hash, chainId, passkey: { key, sign }, reader }),
    ).rejects.toThrow("not installed")
    expect(sign).not.toHaveBeenCalled()
  })
})
