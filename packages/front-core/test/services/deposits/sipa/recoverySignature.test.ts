/**
 * SIPA recovery signatures — the digest layout is pinned against viem's
 * independent abi encoder, and the signature is verified the way
 * `SIPA.recoverERC20` verifies it: recover the signer from the
 * EIP-191-prefixed digest and compare against the derived recovery address.
 */

import { describe, expect, it } from "vitest"
import {
  encodeAbiParameters,
  hashMessage,
  keccak256 as viemKeccak256,
  parseAbiParameters,
  recoverAddress,
} from "viem"
import { Fr } from "@aztec/foundation/curves/bn254"
import { EthAddress } from "@aztec/foundation/eth-address"
import { secp256k1 } from "@noble/curves/secp256k1"
import {
  buildRecoverErc20Digest,
  buildRecoverEthDigest,
  deriveRecoveryAddress,
  deriveRecoveryPrivateKey,
  signSipaRecovery,
} from "../../../../src/core/services/deposits/sipa"

const SIPA = EthAddress.fromString("0x1111111111111111111111111111111111111111")
const TARGET = EthAddress.fromString("0x2222222222222222222222222222222222222222")
const TOKEN = EthAddress.fromString("0x3333333333333333333333333333333333333333")
const CHAIN_ID = 11155111n
const NONCE = Buffer.from("ab".repeat(32), "hex")

const hex = (buffer: Buffer) => `0x${buffer.toString("hex")}` as `0x${string}`

describe("recovery digests", () => {
  it("recoverERC20 digest matches keccak256(abi.encode(sipa, chainId, target, token, nonce))", () => {
    const expected = viemKeccak256(
      encodeAbiParameters(parseAbiParameters("address, uint256, address, address, bytes32"), [
        SIPA.toString() as `0x${string}`,
        CHAIN_ID,
        TARGET.toString() as `0x${string}`,
        TOKEN.toString() as `0x${string}`,
        hex(NONCE),
      ]),
    )
    expect(
      hex(
        buildRecoverErc20Digest({
          contract: SIPA,
          chainId: CHAIN_ID,
          target: TARGET,
          token: TOKEN,
          nonce: NONCE,
        }),
      ),
    ).toBe(expected)
  })

  it("recoverETH digest matches keccak256(abi.encode(sipa, chainId, target, nonce))", () => {
    const expected = viemKeccak256(
      encodeAbiParameters(parseAbiParameters("address, uint256, address, bytes32"), [
        SIPA.toString() as `0x${string}`,
        CHAIN_ID,
        TARGET.toString() as `0x${string}`,
        hex(NONCE),
      ]),
    )
    expect(
      hex(
        buildRecoverEthDigest({ contract: SIPA, chainId: CHAIN_ID, target: TARGET, nonce: NONCE }),
      ),
    ).toBe(expected)
  })

  it("rejects a nonce that is not 32 bytes", () => {
    expect(() =>
      buildRecoverErc20Digest({
        contract: SIPA,
        chainId: CHAIN_ID,
        target: TARGET,
        token: TOKEN,
        nonce: Buffer.from("abcd", "hex"),
      }),
    ).toThrow(/32 bytes/)
  })
})

describe("signSipaRecovery", () => {
  const userPrivateKey = 0x5eedn
  const sharedSecret = new Fr(0xfeedn)
  const recoveryKey = deriveRecoveryPrivateKey(userPrivateKey, sharedSecret)
  const recoveryAddress = deriveRecoveryAddress(
    (() => {
      const { x, y } = secp256k1.ProjectivePoint.BASE.multiply(userPrivateKey).toAffine()
      return { x, y }
    })(),
    sharedSecret,
  )

  it("recovers to the derived recovery address under EIP-191, exactly as SIPA verifies", async () => {
    const digest = buildRecoverErc20Digest({
      contract: SIPA,
      chainId: CHAIN_ID,
      target: TARGET,
      token: TOKEN,
      nonce: NONCE,
    })
    const signature = signSipaRecovery(digest, recoveryKey)
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/)

    // viem applies the same toEthSignedMessageHash prefix SIPA.sol does.
    const recovered = await recoverAddress({
      hash: hashMessage({ raw: hex(digest) }),
      signature,
    })
    expect(recovered.toLowerCase()).toBe(recoveryAddress.toString())
  })

  it("emits low-s signatures with v in {27, 28} (OpenZeppelin ECDSA constraints)", () => {
    const digest = buildRecoverEthDigest({
      contract: SIPA,
      chainId: CHAIN_ID,
      target: TARGET,
      nonce: NONCE,
    })
    const signature = signSipaRecovery(digest, recoveryKey)
    const s = BigInt(`0x${signature.slice(66, 130)}`)
    const v = Number.parseInt(signature.slice(130), 16)
    expect(s <= secp256k1.CURVE.n / 2n).toBe(true)
    expect([27, 28]).toContain(v)
  })
})
