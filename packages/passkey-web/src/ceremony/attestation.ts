/**
 * The registration response's key material, read from the attestation object itself. The
 * browser's `getPublicKey()` and `getPublicKeyAlgorithm()` are convenience parsers over this same
 * object, and a browser that cannot parse a given attestation answers them with defaults rather
 * than errors — so a good key can arrive looking like "algorithm 0". Whether a credential is P-256
 * is a property of its bytes, and the bytes are always here.
 */

import { parseAuthenticatorDataFlags } from "./authenticatorData.js"

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor> | null | boolean | undefined

/** Decodes one definite-length CBOR item — all WebAuthn attestation objects use them. */
function decode(bytes: Uint8Array, start: number): [Cbor, number] {
  const head = bytes[start]
  if (head === undefined) throw new Error("CBOR: unexpected end")
  const major = head >> 5
  const info = head & 0x1f
  let offset = start + 1
  let arg = info
  if (info >= 24 && info <= 27) {
    const width = 1 << (info - 24)
    arg = 0
    for (let i = 0; i < width; i++) arg = arg * 256 + bytes[offset + i]!
    offset += width
  } else if (info > 27) {
    throw new Error("CBOR: indefinite lengths are not used in attestation objects")
  }
  switch (major) {
    case 0:
      return [arg, offset]
    case 1:
      return [-1 - arg, offset]
    case 2:
      return [bytes.subarray(offset, offset + arg), offset + arg]
    case 3:
      return [new TextDecoder().decode(bytes.subarray(offset, offset + arg)), offset + arg]
    case 4: {
      const items: Cbor[] = []
      for (let i = 0; i < arg; i++) {
        const [item, next] = decode(bytes, offset)
        items.push(item)
        offset = next
      }
      return [items, offset]
    }
    case 5: {
      const map = new Map<Cbor, Cbor>()
      for (let i = 0; i < arg; i++) {
        const [key, afterKey] = decode(bytes, offset)
        const [value, afterValue] = decode(bytes, afterKey)
        map.set(key, value)
        offset = afterValue
      }
      return [map, offset]
    }
    case 7:
      return [info === 20 ? false : info === 21 ? true : info === 22 ? null : undefined, offset]
    default:
      throw new Error(`CBOR: unsupported major type ${major}`)
  }
}

/** The `authData` byte string of an attestation object, wherever it sits in the map. */
export function authDataFromAttestation(attestationObject: Uint8Array): Uint8Array | undefined {
  try {
    const [value] = decode(attestationObject, 0)
    if (!(value instanceof Map)) return undefined
    const authData = value.get("authData")
    return authData instanceof Uint8Array ? authData : undefined
  } catch {
    return undefined
  }
}

const AAGUID_OFFSET = 37
const CREDENTIAL_ID_LENGTH_OFFSET = AAGUID_OFFSET + 16
const COSE_KTY_EC2 = 2
const COSE_CRV_P256 = 1

/**
 * The P-256 point of the credential's COSE key as `x || y`, or undefined when the key is not P-256
 * or the buffer carries no attested credential. Only the curve decides: the `alg` field is
 * optional in a COSE key, and a P-256 key is one whether or not it says so.
 */
export function p256FromAuthData(authData: Uint8Array): Uint8Array | undefined {
  try {
    if (!parseAuthenticatorDataFlags(authData).attestedCredentialData) return undefined
    const idLength =
      (authData[CREDENTIAL_ID_LENGTH_OFFSET]! << 8) | authData[CREDENTIAL_ID_LENGTH_OFFSET + 1]!
    const [key] = decode(authData, CREDENTIAL_ID_LENGTH_OFFSET + 2 + idLength)
    if (!(key instanceof Map)) return undefined
    if (key.get(1) !== COSE_KTY_EC2 || key.get(-1) !== COSE_CRV_P256) return undefined
    const x = key.get(-2)
    const y = key.get(-3)
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) return undefined
    if (x.length !== 32 || y.length !== 32) return undefined
    const point = new Uint8Array(64)
    point.set(x, 0)
    point.set(y, 32)
    return point
  } catch {
    return undefined
  }
}

/** The DER prefix every P-256 SubjectPublicKeyInfo starts with; the 65-byte point follows. */
const P256_SPKI_PREFIX = [
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
  0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
]

/** The P-256 point of a `getPublicKey()` SPKI as `x || y`, or undefined when it is any other key. */
export function p256FromSpki(spki: Uint8Array): Uint8Array | undefined {
  if (spki.length !== P256_SPKI_PREFIX.length + 65) return undefined
  if (!P256_SPKI_PREFIX.every((b, i) => spki[i] === b)) return undefined
  if (spki[P256_SPKI_PREFIX.length] !== 0x04) return undefined
  return spki.slice(P256_SPKI_PREFIX.length + 1)
}
