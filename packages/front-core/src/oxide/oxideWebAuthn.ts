/**
 * Maps the device passkey into the shapes OxideAccount's on-chain WebAuthn verifier
 * expects: the stored P-256 public key → oxide `R1PublicKeyArg` (installed via
 * `addAuthKey`), and a passkey sign result → oxide `WebAuthnAuthArg` (the
 * signature for a post-handover r1-signed UserOp).
 *
 * The one non-obvious step is low-`s` normalization: the OZ/oxide P-256 path is
 * signature-malleability-safe and rejects `s > n/2`, but a real authenticator may
 * return the high-`s` sibling — so the adapter folds it back to `n - s`. The
 * challenge/type indices are passed through from the authenticator (computed by
 * `indexOf` over the real clientDataJSON), NOT hardcoded, since iOS may add fields.
 */

import { p256 } from "@noble/curves/p256"
import { type Hex, bytesToHex } from "viem"
import type { R1PublicKeyArg, WebAuthnAuthArg } from "@oxide/l1-contracts"

import { bytes32 } from "./oxideAccountKeys"

/** The subset of a passkey sign result an oxide r1 UserOp signature consumes. */
export interface PasskeySignResult {
  /** 0x-prefixed 64-byte compact ECDSA signature (r ‖ s). */
  signature: string
  webauthn: {
    authenticatorData: string
    clientDataJSON: string
    challengeIndex: number
    typeIndex: number
  }
}

/** Fold a possibly-high `s` into its canonical low-`s` form (`s <= n/2`). */
function lowS(s: bigint): bigint {
  const n = p256.CURVE.n
  return s > n / 2n ? n - s : s
}

/** Split the stored `x ‖ y` passkey public key (0x + 128 hex) into oxide `R1PublicKeyArg{qx,qy}`. */
export function pubkeyToR1KeyArg(pubkeyHex: string): R1PublicKeyArg {
  const raw = pubkeyHex.startsWith("0x") ? pubkeyHex.slice(2) : pubkeyHex
  if (raw.length !== 128) {
    throw new Error(
      `pubkeyToR1KeyArg: expected a 64-byte (x‖y) passkey key, got ${raw.length / 2} bytes`,
    )
  }
  return { qx: `0x${raw.slice(0, 64)}`, qy: `0x${raw.slice(64, 128)}` }
}

/** Map a passkey sign result into the on-chain `WebAuthnAuthArg`, normalizing `s` to low-`s`. */
export function toWebAuthnAuthArg(result: PasskeySignResult): WebAuthnAuthArg {
  const raw = result.signature.startsWith("0x") ? result.signature.slice(2) : result.signature
  if (raw.length !== 128) {
    throw new Error(
      `toWebAuthnAuthArg: expected a 64-byte (r‖s) signature, got ${raw.length / 2} bytes`,
    )
  }
  const r = BigInt(`0x${raw.slice(0, 64)}`)
  const s = lowS(BigInt(`0x${raw.slice(64, 128)}`))
  return {
    r: bytes32(r),
    s: bytes32(s),
    challengeIndex: BigInt(result.webauthn.challengeIndex),
    typeIndex: BigInt(result.webauthn.typeIndex),
    authenticatorData: result.webauthn.authenticatorData as Hex,
    clientDataJSON: result.webauthn.clientDataJSON,
  }
}

/**
 * The passkey credential id as the bytes `OxideAccount.addAuthKey` records under `metadata`.
 * The wallet holds the id base64url-encoded; the on-chain value is its raw bytes.
 */
export function credentialIdToMetadata(credentialId: string): Hex {
  // Reject anything outside the base64url alphabet: `Buffer.from(…, "base64")` is lenient and would
  // silently drop stray characters. (Normalize to "base64" first — some Buffer polyfills lack
  // "base64url"; the same idiom the handshake/paymentRequest codecs use.)
  if (credentialId.length === 0 || !/^[A-Za-z0-9_-]+$/.test(credentialId)) {
    throw new Error("credentialIdToMetadata: not a base64url string")
  }
  let b64 = credentialId.replace(/-/g, "+").replace(/_/g, "/")
  while (b64.length % 4) b64 += "="
  return bytesToHex(Uint8Array.from(Buffer.from(b64, "base64")))
}
