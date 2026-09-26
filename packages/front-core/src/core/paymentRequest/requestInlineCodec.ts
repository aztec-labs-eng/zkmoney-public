/**
 * requestInlineCodec — the serverless payment-request link's wire codec.
 *
 * A payment request can be shared as a link (`…/request#<fragment>`) that any
 * app user opens and fulfills with an L2 send. The whole request rides inline
 * in the URL fragment as plaintext CBOR — no server, no encryption (the link is
 * a bearer reference to a public "please pay me" bill, mirroring the paylink
 * posture). This module is the single, symmetric encode/decode pair.
 *
 *   encodeRequestInline(packet) → base64url(CBOR)  — built by the requester
 *   decodeRequestInline(b64url) → packet           — read locally by the payer
 *
 * The packet is a compact integer-keyed CBOR map. The amount is a fixed 16-byte
 * u128 (reusing the paylink codec idiom); every other field is a plain CBOR
 * string / number. Absent optionals are omitted.
 *
 * Decode is **fail-closed**: malformed base64url / CBOR, an unknown format int,
 * an unknown map key, a wrong-typed field, an out-of-range amount, or a payload
 * over the size cap all collapse to a single opaque `RequestDecodeError` — no
 * partial packet ever escapes. Expiry is checked SOFT at the UI, never here.
 *
 * Lives in `@obsidion/front-core` (pure transform, only strings/numbers — no
 * `Fr`/`Point`), NOT in `@obsidion/sdk`.
 */

import { encode as cborEncode, decode as cborDecode } from "cbor-x"
import { Buffer } from "buffer"

/* -------------------------------------------------------------------------- */
/*  Packet type                                                               */
/* -------------------------------------------------------------------------- */

export interface RequestInlinePacket {
  /**
   * Join key minted by the requester; echoed on the fulfilled signal. v3: the
   * lowercase 0x-hex of a 254-bit BN254 field (32 raw bytes on the wire),
   * aligning it with the transfer-log `reference` field. v1/v2: opaque text.
   */
  requestId: string
  /** Requester's normalized Aztec tag — the payee. */
  requesterTag: string
  /** Raw amount in the token's base units. `0n` = "any amount". */
  amountAtomic: bigint
  /** Optional token symbol/ticker. */
  tokenSymbol?: string
  /** Optional short note from the requester. */
  note?: string
  /** Optional soft expiry (epoch ms) — advisory; checked at the UI. */
  expiresAt?: number
  /** Aztec network the request targets. */
  networkId: string
  /**
   * Decimal exponent that scales `amountAtomic` back to a human amount. Absent
   * in legacy (pre-v2) links, whose amounts were always 6-dp — a missing value
   * is read as 6 by consumers.
   */
  tokenDecimals?: number
  /**
   * Requested token's L2 address (0x-hex). Required on encode (v3); absent only
   * when decoding legacy v1/v2 links.
   */
  tokenAddress?: string
  /**
   * Requester's L2 address (0x-hex) — lets the payer pin the recipient against
   * tag re-registration. Optional.
   */
  requesterAddress?: string
  /**
   * Self-broadcast L1 SIPA (0x-hex, 20 bytes). Optional on v3 so an accountless
   * payer can paint the deposit QR from the fragment; absent packets resolve
   * via CCIP at consume time.
   */
  sipaAddress?: string
}

/* -------------------------------------------------------------------------- */
/*  Format / keys / sizes                                                     */
/* -------------------------------------------------------------------------- */

// The layout the encoder emits. v2 added the optional decimals key; v3 made
// requestId a 32-byte field, added the token/requester L2 address keys, and
// carries an optional 20-byte L1 SIPA. Decode still accepts v1/v2.
const FORMAT = 3
const SUPPORTED_FORMATS = new Set<number>([1, 2, 3])

const KEY_FORMAT = 1
const KEY_REQUEST_ID = 2
const KEY_REQUESTER_TAG = 3
const KEY_AMOUNT = 4
const KEY_TOKEN_SYMBOL = 5
const KEY_NOTE = 6
const KEY_EXPIRES_AT = 7
const KEY_NETWORK_ID = 8
const KEY_DECIMALS = 9
const KEY_TOKEN_ADDRESS = 10
const KEY_REQUESTER_ADDRESS = 11
const KEY_SIPA_ADDRESS = 12

/** Every key a given wire format knows. An unknown key fails closed. */
const KNOWN_KEYS_LEGACY = new Set<number>([
  KEY_FORMAT,
  KEY_REQUEST_ID,
  KEY_REQUESTER_TAG,
  KEY_AMOUNT,
  KEY_TOKEN_SYMBOL,
  KEY_NOTE,
  KEY_EXPIRES_AT,
  KEY_NETWORK_ID,
  KEY_DECIMALS,
])
const KNOWN_KEYS_V3 = new Set<number>([
  ...KNOWN_KEYS_LEGACY,
  KEY_TOKEN_ADDRESS,
  KEY_REQUESTER_ADDRESS,
  KEY_SIPA_ADDRESS,
])

const MAX_FRAGMENT_BYTES = 512 // DoS guard before decode.
const AMOUNT_BYTES = 16 // u128
const FIELD_BYTES = 32 // BN254 field / L2 address
const ETH_ADDRESS_BYTES = 20 // L1 SIPA
const BN254_FR_MODULUS = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n

/* -------------------------------------------------------------------------- */
/*  Errors                                                                    */
/* -------------------------------------------------------------------------- */

/** The single opaque decode reject. No field detail escapes (fail-closed). */
export class RequestDecodeError extends Error {
  constructor() {
    super("Invalid payment-request link")
    this.name = "RequestDecodeError"
  }
}

/** Thrown by `encodeRequestInline` when handed a packet it cannot represent. */
export class RequestEncodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RequestEncodeError"
  }
}

/* -------------------------------------------------------------------------- */
/*  Encode                                                                    */
/* -------------------------------------------------------------------------- */

export function encodeRequestInline(packet: RequestInlinePacket): string {
  if (!packet.requestId) throw new RequestEncodeError("Missing requestId")
  if (!packet.requesterTag) throw new RequestEncodeError("Missing requesterTag")
  if (!packet.networkId) throw new RequestEncodeError("Missing networkId")
  if (!packet.tokenAddress) throw new RequestEncodeError("Missing tokenAddress")

  const map = new Map<number, unknown>()
  map.set(KEY_FORMAT, FORMAT)
  map.set(KEY_REQUEST_ID, hexToFieldBytes(packet.requestId))
  map.set(KEY_REQUESTER_TAG, packet.requesterTag)
  map.set(KEY_AMOUNT, amountToBytes(packet.amountAtomic))
  map.set(KEY_NETWORK_ID, packet.networkId)
  map.set(KEY_TOKEN_ADDRESS, hexToFieldBytes(packet.tokenAddress))
  if (packet.requesterAddress !== undefined) {
    map.set(KEY_REQUESTER_ADDRESS, hexToFieldBytes(packet.requesterAddress))
  }
  if (packet.sipaAddress !== undefined) {
    map.set(KEY_SIPA_ADDRESS, hexToAddressBytes(packet.sipaAddress))
  }
  if (packet.tokenSymbol !== undefined) map.set(KEY_TOKEN_SYMBOL, packet.tokenSymbol)
  if (packet.note !== undefined) map.set(KEY_NOTE, packet.note)
  if (packet.expiresAt !== undefined) {
    if (!isWireTime(packet.expiresAt)) throw new RequestEncodeError("Invalid expiresAt")
    map.set(KEY_EXPIRES_AT, packet.expiresAt)
  }
  if (packet.tokenDecimals !== undefined) {
    if (!isDecimals(packet.tokenDecimals)) throw new RequestEncodeError("Invalid tokenDecimals")
    map.set(KEY_DECIMALS, packet.tokenDecimals)
  }

  return toBase64Url(cborEncode(map))
}

/* -------------------------------------------------------------------------- */
/*  Decode                                                                    */
/* -------------------------------------------------------------------------- */

export function decodeRequestInline(b64url: string): RequestInlinePacket {
  try {
    return decodeStrict(b64url)
  } catch (err) {
    if (err instanceof RequestDecodeError) throw err
    throw new RequestDecodeError()
  }
}

function decodeStrict(b64url: string): RequestInlinePacket {
  const bytes = fromBase64Url(b64url)
  if (bytes.length === 0 || bytes.length > MAX_FRAGMENT_BYTES) throw new RequestDecodeError()

  let decoded: unknown
  try {
    decoded = cborDecode(bytes)
  } catch {
    throw new RequestDecodeError()
  }

  const format = asUint(readRequired(decoded, KEY_FORMAT))
  if (!SUPPORTED_FORMATS.has(format)) throw new RequestDecodeError()

  const knownKeys = format >= 3 ? KNOWN_KEYS_V3 : KNOWN_KEYS_LEGACY
  for (const k of allKeys(decoded)) {
    if (!knownKeys.has(k)) throw new RequestDecodeError()
  }

  const packet: RequestInlinePacket = {
    requestId:
      format >= 3
        ? fieldBytesToHex(readRequired(decoded, KEY_REQUEST_ID))
        : asString(readRequired(decoded, KEY_REQUEST_ID)),
    requesterTag: asString(readRequired(decoded, KEY_REQUESTER_TAG)),
    amountAtomic: bytesToAmount(asAmountBytes(readRequired(decoded, KEY_AMOUNT))),
    networkId: asString(readRequired(decoded, KEY_NETWORK_ID)),
  }

  if (format >= 3) {
    packet.tokenAddress = fieldBytesToHex(readRequired(decoded, KEY_TOKEN_ADDRESS))
    // Like decimals: a present-but-null address is malformed, not "absent".
    const requesterAddress = readField(decoded, KEY_REQUESTER_ADDRESS)
    if (requesterAddress !== undefined) packet.requesterAddress = fieldBytesToHex(requesterAddress)
    const sipaAddress = readField(decoded, KEY_SIPA_ADDRESS)
    if (sipaAddress !== undefined) packet.sipaAddress = addressBytesToHex(sipaAddress)
  }

  const tokenSymbol = readOptional(decoded, KEY_TOKEN_SYMBOL)
  if (tokenSymbol !== undefined) packet.tokenSymbol = asString(tokenSymbol)

  const note = readOptional(decoded, KEY_NOTE)
  if (note !== undefined) packet.note = asString(note)

  const expiresAt = readOptional(decoded, KEY_EXPIRES_AT)
  if (expiresAt !== undefined) {
    if (!isWireTime(expiresAt)) throw new RequestDecodeError()
    packet.expiresAt = expiresAt
  }

  // A present decimals key must be valid — unlike the cosmetic optionals, a
  // silently-dropped decimals defaults to 6 and would mis-scale, so read the raw
  // field and let asDecimals reject an explicit null / wrong type (fail-closed).
  const rawDecimals = readField(decoded, KEY_DECIMALS)
  if (rawDecimals !== undefined) packet.tokenDecimals = asDecimals(rawDecimals)

  return packet
}

/* -------------------------------------------------------------------------- */
/*  Field reading (tolerant of Map or plain-object CBOR decode)               */
/* -------------------------------------------------------------------------- */

function allKeys(decoded: unknown): number[] {
  if (decoded instanceof Map) return [...decoded.keys()].map(toKeyNumber)
  if (decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)) {
    return Object.keys(decoded).map(toKeyNumber)
  }
  throw new RequestDecodeError()
}

function toKeyNumber(k: unknown): number {
  const n = Number(k)
  if (!Number.isInteger(n)) throw new RequestDecodeError()
  return n
}

function readField(decoded: unknown, key: number): unknown {
  if (decoded instanceof Map) return decoded.get(key)
  if (decoded !== null && typeof decoded === "object") {
    return (decoded as Record<string, unknown>)[String(key)]
  }
  throw new RequestDecodeError()
}

function readRequired(decoded: unknown, key: number): unknown {
  const value = readField(decoded, key)
  if (value === undefined || value === null) throw new RequestDecodeError()
  return value
}

function readOptional(decoded: unknown, key: number): unknown {
  const value = readField(decoded, key)
  return value === null ? undefined : value
}

/* -------------------------------------------------------------------------- */
/*  Primitives                                                                */
/* -------------------------------------------------------------------------- */

function amountToBytes(amount: bigint): Buffer {
  if (amount < 0n || amount >= 1n << 128n) throw new RequestEncodeError("amount out of u128 range")
  const b = Buffer.alloc(AMOUNT_BYTES)
  let x = amount
  for (let i = AMOUNT_BYTES - 1; i >= 0; i--) {
    b[i] = Number(x & 0xffn)
    x >>= 8n
  }
  return b
}

function bytesToAmount(b: Uint8Array): bigint {
  let x = 0n
  for (const byte of b) x = (x << 8n) | BigInt(byte)
  return x
}

function asAmountBytes(value: unknown): Uint8Array {
  // Buffer is a Uint8Array subclass, so this also accepts cbor-x's Node output.
  if (!(value instanceof Uint8Array) || value.length !== AMOUNT_BYTES)
    throw new RequestDecodeError()
  return value
}

/**
 * Encode side: 0x-hex → `len` BE bytes, rejecting zero. `max` additionally bounds the value —
 * the BN254 modulus for a field, nothing for an L1 address.
 */
function hexToBytes(hex: string, len: number, max?: bigint): Buffer {
  if (!new RegExp(`^0x[0-9a-fA-F]{${len * 2}}$`).test(hex)) {
    throw new RequestEncodeError("Invalid hex")
  }
  const v = BigInt(hex)
  if (v === 0n || (max !== undefined && v >= max)) throw new RequestEncodeError("Out of range")
  return Buffer.from(hex.slice(2), "hex")
}

/** Decode side: `len` BE bytes → lowercase 0x-hex. Fail-closed on length, zero, and `max`. */
function bytesToHex(value: unknown, len: number, max?: bigint): string {
  if (!(value instanceof Uint8Array) || value.length !== len) throw new RequestDecodeError()
  const v = bytesToAmount(value)
  if (v === 0n || (max !== undefined && v >= max)) throw new RequestDecodeError()
  return `0x${Buffer.from(value).toString("hex")}`
}

const hexToFieldBytes = (hex: string) => hexToBytes(hex, FIELD_BYTES, BN254_FR_MODULUS)
const fieldBytesToHex = (value: unknown) => bytesToHex(value, FIELD_BYTES, BN254_FR_MODULUS)
const hexToAddressBytes = (hex: string) => hexToBytes(hex, ETH_ADDRESS_BYTES)
const addressBytesToHex = (value: unknown) => bytesToHex(value, ETH_ADDRESS_BYTES)

function asString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new RequestDecodeError()
  return value
}

function asUint(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new RequestDecodeError()
  }
  return value
}

/** Token decimal exponent: a small non-negative int. Fail-closed on anything else. */
function isDecimals(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 36
}

function asDecimals(value: unknown): number {
  if (typeof value !== "number" || !isDecimals(value)) throw new RequestDecodeError()
  return value
}

function isWireTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

/* -------------------------------------------------------------------------- */
/*  base64url (some Buffer polyfills lack the "base64url" encoding)           */
/* -------------------------------------------------------------------------- */

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

function fromBase64Url(b64url: string): Uint8Array {
  if (typeof b64url !== "string" || b64url.length === 0) throw new RequestDecodeError()
  // Reject anything outside the base64url alphabet up front — `Buffer.from(…,
  // "base64")` is lenient and would silently drop stray characters.
  if (!/^[A-Za-z0-9_-]+$/.test(b64url)) throw new RequestDecodeError()
  let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/")
  while (b64.length % 4) b64 += "="
  return Uint8Array.from(Buffer.from(b64, "base64"))
}
