/**
 * XMTP signer derivation and EIP-191 signing.
 *
 * Each Obsidion user's XMTP inbox is backed by a secp256k1 key deterministically
 * derived from their Aztec secret as `sha256(domain || secret) mod n`. The derived
 * identity is treated by XMTP as an EOA.
 *
 * Compromise model: leaking the Aztec secret implies leaking the XMTP identity.
 * This matches the Aztec transaction compromise surface and is intentional.
 */

import { secp256k1 } from "@noble/curves/secp256k1"
import { sha256 } from "@aztec/foundation/crypto/sha256"
import { keccak_256 } from "@noble/hashes/sha3"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils"
import { bytesToBigInt, getAddress, type Address, type Hex } from "viem"

const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

/** Domain separator for the XMTP signer derivation */
export const XMTP_SIGNING_DOMAIN_SEPARATOR = "OBSIDION_XMTP_SIGNING:"

function bigIntToBytes32(value: bigint): Uint8Array {
  const bytes = new Uint8Array(32)
  let remaining = value
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return bytes
}

/**
 * Key material for the XMTP signer derived from an Aztec secret.
 */
export interface XmtpSignerMaterial {
  /** secp256k1 private key as 32 raw bytes */
  privateKey: Uint8Array
  /** Same private key as bigint (convenience) */
  privateKeyBigInt: bigint
  /** Compressed secp256k1 public key (33 bytes) */
  publicKey: Uint8Array
  /** EIP-55 checksummed Ethereum-style address used as the XMTP identifier */
  address: Address
}

/**
 * Derive the XMTP signer keypair from an Aztec secret.
 *
 * Derivation:
 *   scalar = sha256("OBSIDION_XMTP_SIGNING:" || secretBytes) mod n
 *
 * @param secretKey Aztec secret as hex string or bigint (any length < 32 bytes is left-padded)
 * @returns Key material including the EIP-55 address XMTP will treat as the identifier
 * @throws if the derivation produces a zero scalar (cryptographically impossible for real inputs)
 */
export function deriveXmtpSigner(secretKey: bigint | Hex): XmtpSignerMaterial {
  const secretBytes =
    typeof secretKey === "bigint"
      ? bigIntToBytes32(secretKey)
      : hexToBytes((secretKey as string).slice(2).padStart(64, "0"))

  const preimage = new Uint8Array([
    ...new TextEncoder().encode(XMTP_SIGNING_DOMAIN_SEPARATOR),
    ...secretBytes,
  ])
  const hash = sha256(Buffer.from(preimage))
  const scalar = bytesToBigInt(hash) % CURVE_ORDER

  if (scalar === 0n) {
    throw new Error("XMTP signer derivation produced a zero scalar")
  }

  const privateKey = bigIntToBytes32(scalar)
  const publicKey = secp256k1.getPublicKey(privateKey, true)
  const address = deriveEvmAddress(privateKey)

  return {
    privateKey,
    privateKeyBigInt: scalar,
    publicKey,
    address,
  }
}

/**
 * Derive an EIP-55 checksummed Ethereum address from a secp256k1 private key.
 * Algorithm: keccak256(uncompressed pubkey bytes, 0x04 prefix dropped), last 20 bytes.
 */
export function deriveEvmAddress(privateKey: Uint8Array): Address {
  const uncompressed = secp256k1.getPublicKey(privateKey, false) // 65 bytes, 0x04-prefixed
  const pubKeyBody = uncompressed.slice(1)
  const hash = keccak_256(pubKeyBody)
  const addressBytes = hash.slice(12)
  return getAddress(`0x${bytesToHex(addressBytes)}`)
}

/**
 * Produce an EIP-191 `personal_sign` signature over `message` using `privateKey`.
 *
 * Returns the 65-byte `r || s || v` signature as a `0x`-prefixed hex string.
 * This is exactly what an XMTP EOA `signMessage` is expected to return.
 *
 * Uses low-s normalization so signatures are canonical.
 */
export function signEip191(privateKey: Uint8Array, message: string): Hex {
  const msgBytes = new TextEncoder().encode(message)
  const prefixBytes = new TextEncoder().encode(
    `\x19Ethereum Signed Message:\n${msgBytes.length}`,
  )
  const toHash = new Uint8Array(prefixBytes.length + msgBytes.length)
  toHash.set(prefixBytes, 0)
  toHash.set(msgBytes, prefixBytes.length)
  const digest = keccak_256(toHash)

  const sig = secp256k1.sign(digest, privateKey, { lowS: true })
  const r = bigIntToBytes32(sig.r)
  const s = bigIntToBytes32(sig.s)
  const v = (sig.recovery ?? 0) + 27

  const signature = new Uint8Array(65)
  signature.set(r, 0)
  signature.set(s, 32)
  signature[64] = v

  return `0x${bytesToHex(signature)}` as Hex
}
