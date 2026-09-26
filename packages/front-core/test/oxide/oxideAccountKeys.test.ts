import { describe, expect, it } from "vitest"
import { bytesToHex, concat, keccak256, toBytes, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { secp256k1 } from "@noble/curves/secp256k1"
import { Fr } from "@aztec/aztec.js/fields"

import {
  deriveBootstrapKey,
  deriveStealthKey,
  deriveSwapEscrowRecoverySalt,
  type FieldLike,
} from "../../src/oxide/oxideAccountKeys"

// Fixed wallet secret — mimics Aztec `Fr.toString()` (0x + 64 hex).
const SECRET: FieldLike = { toString: () => `0x${"11".repeat(32)}` }
const SECRET_2: FieldLike = { toString: () => `0x${"22".repeat(32)}` }

// Independent reconstruction of oxide's `deriveScalar` (account_keys.ts) — the test
// asserts byte-for-byte parity with oxide's formula, not merely internal determinism.
function oxideScalar(secretHex: string, label: string, order: bigint): bigint {
  const s = BigInt(keccak256(concat([secretHex as Hex, bytesToHex(toBytes(label))]))) % order
  return s === 0n ? 1n : s
}

// Pinned regression vectors for SECRET (captured from the derivation).
const EXPECTED_BOOTSTRAP_ADDRESS = "0x95748F83352CC888ce9a1F61b59A79C0A7ADd8cb"
const EXPECTED_STEALTH_X =
  60108653645162358043287054163428756903413326448798986126465506735450524194451n
const EXPECTED_STEALTH_Y =
  7241406344864825716384357866748866665908494063114572139698909950504214449586n

describe("oxideAccountKeys — deriveBootstrapKey", () => {
  it("matches oxide's domain-separated scalar → secp256k1 EOA", () => {
    const scalar = oxideScalar(SECRET.toString(), "oxide:l1-bootstrap", secp256k1.CURVE.n)
    const expected = privateKeyToAccount(`0x${scalar.toString(16).padStart(64, "0")}`)
    expect(deriveBootstrapKey(SECRET).address).toBe(expected.address)
  })

  it("is deterministic (resume-critical) and secret-separated", () => {
    expect(deriveBootstrapKey(SECRET).address).toBe(deriveBootstrapKey(SECRET).address)
    expect(deriveBootstrapKey(SECRET).address).not.toBe(deriveBootstrapKey(SECRET_2).address)
  })

  it("matches the pinned regression address", () => {
    expect(deriveBootstrapKey(SECRET).address).toBe(EXPECTED_BOOTSTRAP_ADDRESS)
  })
})

describe("oxideAccountKeys — deriveStealthKey", () => {
  it("scalar matches oxide's user-stealth derivation", () => {
    expect(deriveStealthKey(SECRET).scalar).toBe(
      oxideScalar(SECRET.toString(), "oxide:user-stealth", secp256k1.CURVE.n),
    )
  })

  it("publicKey is the uncompressed secp256k1 point of the scalar (on-curve)", () => {
    const { scalar, publicKey } = deriveStealthKey(SECRET)
    // y^2 == x^3 + 7 (mod p) — the stealth point must lie on secp256k1.
    const p = secp256k1.CURVE.p
    expect((publicKey.y * publicKey.y) % p).toBe((publicKey.x ** 3n + 7n) % p)
    expect(scalar).toBeGreaterThan(0n)
  })

  it("matches the pinned regression point + is deterministic", () => {
    expect(deriveStealthKey(SECRET).publicKey.x).toBe(EXPECTED_STEALTH_X)
    expect(deriveStealthKey(SECRET).publicKey.y).toBe(EXPECTED_STEALTH_Y)
    expect(deriveStealthKey(SECRET).scalar).toBe(deriveStealthKey(SECRET).scalar)
  })
})

describe("oxideAccountKeys — deriveSwapEscrowRecoverySalt", () => {
  const NONCE = `0x${"ab".repeat(32)}` as const
  const NONCE_2 = `0x${"cd".repeat(32)}` as const

  it("is the domain-separated field element over the secret and the nonce", () => {
    const salt = deriveSwapEscrowRecoverySalt(SECRET, NONCE)
    expect(salt).toBeInstanceOf(Fr)
    expect(salt.toBigInt()).toBe(
      oxideScalar(SECRET.toString(), `oxide:swap-escrow-recovery-salt:${NONCE}`, Fr.MODULUS),
    )
  })

  it("is deterministic per (secret, nonce) and separated on both", () => {
    const salt = deriveSwapEscrowRecoverySalt(SECRET, NONCE)
    expect(deriveSwapEscrowRecoverySalt(SECRET, NONCE).equals(salt)).toBe(true)
    expect(deriveSwapEscrowRecoverySalt(SECRET, NONCE_2).equals(salt)).toBe(false)
    expect(deriveSwapEscrowRecoverySalt(SECRET_2, NONCE).equals(salt)).toBe(false)
  })

  it("normalizes the nonce's hex case and rejects anything but 0x-prefixed 32 bytes", () => {
    const upper = `0x${NONCE.slice(2).toUpperCase()}` as const
    expect(
      deriveSwapEscrowRecoverySalt(SECRET, upper).equals(
        deriveSwapEscrowRecoverySalt(SECRET, NONCE),
      ),
    ).toBe(true)
    for (const bad of ["0x1234", `0x${"ab".repeat(33)}`, "ab".repeat(32)]) {
      expect(() => deriveSwapEscrowRecoverySalt(SECRET, bad as `0x${string}`)).toThrow(/32-byte/)
    }
  })
})
