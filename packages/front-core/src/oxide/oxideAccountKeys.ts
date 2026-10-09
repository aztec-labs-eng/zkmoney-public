/**
 * Deterministic a1 key derivation from the wallet master secret, byte-identical to
 * oxide's `account_keys.ts`. Reproducibility is load-bearing: a crash between
 * `/bundler/bootstrap` and `userSignup` must re-derive the SAME bootstrap EOA (so
 * the predicted L1 account is unchanged and bootstrap 409-resumes) rather than mint
 * a second account and burn a second bundler-funded bootstrap.
 *
 * The R1 key is NOT derived here — it is the device's real persisted passkey public
 * key (a derived software R1 would fail OxideAccount validation when the passkey
 * later signs). Only the secp256k1 bootstrap and stealth keys and the swap-escrow recovery salt
 * are derived.
 */

import {
  type Hex,
  type PrivateKeyAccount,
  bytesToHex,
  concat,
  hexToBytes,
  keccak256,
  toBytes,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { secp256k1 } from "@noble/curves/secp256k1"
import { Fr } from "@aztec/aztec.js/fields"
import { OXIDE_L1_BOOTSTRAP_KEY_LABEL } from "@obsidion/core/constants"

/** Aztec `Fr` (or any field element); only `.toString()` (0x-hex) is used, matching oxide. */
export interface FieldLike {
  toString(): string
}

/** oxide `K1Point` — uncompressed secp256k1 point coordinates. */
export interface K1Point {
  x: bigint
  y: bigint
}

/** 0x-prefixed left-padded 32-byte hex of a scalar / curve coordinate. Mirrors oxide `bytes32`. */
export function bytes32(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}`
}

/**
 * Domain-separated scalar `keccak256(secretHex ‖ utf8(label)) mod order`, floored to
 * 1. Same secret + label always yields the same scalar.
 */
function deriveScalar(masterSecret: FieldLike, label: string, order: bigint): bigint {
  const secretHex = masterSecret.toString()
  // Registration derived from the Fr's 0x-hex form; any other stringification
  // (a bigint's decimal digits are still valid hex chars!) would silently
  // derive a DIFFERENT key. Fail loud instead.
  if (!/^0x[0-9a-fA-F]+$/.test(secretHex)) {
    throw new Error(
      `deriveScalar: input.toString() must be 0x-hex, got "${secretHex.slice(0, 12)}…"`,
    )
  }
  const scalar = BigInt(keccak256(concat([secretHex as Hex, bytesToHex(toBytes(label))]))) % order
  return scalar === 0n ? 1n : scalar
}

/** The secp256k1 bootstrap EOA that owns the L1 account before the R1 handover and signs the upgrade digest. */
export function deriveBootstrapKey(masterSecret: FieldLike): PrivateKeyAccount {
  return privateKeyToAccount(
    bytes32(deriveScalar(masterSecret, OXIDE_L1_BOOTSTRAP_KEY_LABEL, secp256k1.CURVE.n)),
  )
}

/**
 * The secp256k1 stealth key recorded as `UserRecord.publicKey`. The scalar is
 * returned so the hook can persist it (SP-B spends the user's SIPAs from it).
 */
export function deriveStealthKey(masterSecret: FieldLike): { scalar: bigint; publicKey: K1Point } {
  const scalar = deriveScalar(masterSecret, "oxide:user-stealth", secp256k1.CURVE.n)
  const uncompressed = secp256k1.getPublicKey(hexToBytes(bytes32(scalar)), false)
  return {
    scalar,
    publicKey: {
      x: BigInt(bytesToHex(uncompressed.subarray(1, 33))),
      y: BigInt(bytesToHex(uncompressed.subarray(33, 65))),
    },
  }
}

/**
 * The salt hiding the recovery account in a swap escrow's `recoveryCommitment`. Derived from the
 * master secret and the escrow nonce, so a wallet restored from its secret recovers the escrow the
 * way it recovers a SIPA from its shared secret.
 */
export function deriveSwapEscrowRecoverySalt(masterSecret: FieldLike, swapNonce: Hex): Fr {
  if (!/^0x[0-9a-fA-F]{64}$/.test(swapNonce)) {
    throw new Error("deriveSwapEscrowRecoverySalt: swapNonce must be 0x-prefixed 32-byte hex")
  }
  return new Fr(
    deriveScalar(
      masterSecret,
      `oxide:swap-escrow-recovery-salt:${swapNonce.toLowerCase()}`,
      Fr.MODULUS,
    ),
  )
}

/**
 * The two salts a Sky savings escrow commits to. The recipient salt is the secret of the deposit the
 * escrow makes into the destination portal, which this account claims; the recovery salt hides the
 * recovery account. Both come from the master secret and the escrow nonce, so a wallet restored from
 * its secret can still claim or recover its moves.
 */
export function deriveSkyEscrowSalts(
  masterSecret: FieldLike,
  nonce: Hex,
): { recipient: Fr; recovery: Fr } {
  if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) {
    throw new Error("deriveSkyEscrowSalts: nonce must be 0x-prefixed 32-byte hex")
  }
  const salt = (purpose: string) =>
    new Fr(
      deriveScalar(
        masterSecret,
        `oxide:sky-escrow-${purpose}-salt:${nonce.toLowerCase()}`,
        Fr.MODULUS,
      ),
    )
  return { recipient: salt("recipient"), recovery: salt("recovery") }
}
