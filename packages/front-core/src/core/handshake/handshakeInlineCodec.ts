/**
 * handshakeInlineCodec — the serverless QR / link contact handshake's wire codec.
 *
 * v2 of the handshake removes the server entirely: instead of uploading an
 * encrypted blob and handing out a link that carries a decryption key, the
 * *whole* handshake packet rides inline in the QR / link as plaintext CBOR. This
 * module is the single, symmetric encode/decode pair for that packet.
 *
 *   encodeInline(packet) → base64url(CBOR)   — built offline by the sharer
 *   decodeInline(b64url) → packet            — read locally by the scanner (no fetch)
 *
 * The packet is a compact CBOR map with **integer keys** (most of the byte
 * saving) and **raw byte strings** for the address / UUID fields; absent
 * optionals are omitted. `version` is split into a format int + chain int via
 * the pinned maps below (independent of the `Network` enum's declaration order),
 * and `kind` selects the flow (only `"handshake"` today; payment-request /
 * privacy are reserved for their own future units).
 *
 * Decode is **fail-closed**: malformed base64url / CBOR, an unknown
 * format/chain/kind int, an unknown map key, a wrong-length byte string, a
 * missing required field, or an address that doesn't round-trip to a canonical
 * non-zero value all collapse to a single opaque `HandshakeDecodeError` — no
 * partial packet ever escapes. The codec is the single enforcement point so the
 * scan hook, the bot, and any future consumer get the same guarantee.
 *
 * Lives in `@obsidion/front-core` (it is a pure transform, no contract calls) —
 * NOT in `@obsidion/sdk`. It replaced the old sdk `HandshakeConnectPayload` /
 * `CreatedConnect` types (which lived in the now-removed
 * `HandshakeConnectService`).
 */

import { encode as cborEncode, decode as cborDecode } from "cbor-x"
import { Buffer } from "buffer"
import { bytesToHex, getAddress, hexToBytes } from "viem"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { normalizeTag } from "../../utils/normalizeTag"

/* -------------------------------------------------------------------------- */
/*  Packet type                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The handshake "kind" carried inside the packet so one route + one fragment
 * shape serves every flavor. Only `"handshake"` is live; `"payment-request"`
 * and `"privacy"` are reserved for their own units (they are NOT yet assigned
 * a CBOR int, so a packet claiming them fails closed on decode until then).
 */
export type HandshakeKind = "handshake"

/**
 * The inline handshake packet. Self-contained identity: a scanner learns
 * everything it needs to add the sharer + connect back, with no server fetch.
 *
 * The sharer's `tag` is a packet field: the link host carries no identity, so the scanner reads
 * the tag from here and cross-checks it against the registry.
 *
 * `version` couples the format version with the chain it targets (e.g.
 * `"1.0:testnet"`) so an unknown / foreign version rejects. The address fields
 * are optional to support the non-discoverable / web-fallback flavors.
 */
export interface HandshakeInlinePacket {
  /** `{format}:{chain}`, e.g. "1.0:testnet". Unknown format/chain → reject. */
  version: string
  /** Flow selector. Only `"handshake"` today. */
  kind: HandshakeKind
  /** The sharer's XMTP handle (Ethereum-format address) — the connect-back target. */
  xmtpHandle: string
  /** Per-share UUID v4 the connect-back echoes back for local matching. */
  uuid: string
  /** Optional L1 stealth address (web-fallback deposit target). */
  stealthAddress?: string
  /** Optional L2 (Aztec) address for direct display / payment. */
  l2Address?: string
  /** Optional mint time (epoch ms) for staleness display — advisory only. */
  time?: number
  /** The sharer's registry tag, bare and lowercase. Absent for a non-discoverable sharer. */
  tag?: string
}

/* -------------------------------------------------------------------------- */
/*  Pinned format / chain / kind maps                                         */
/* -------------------------------------------------------------------------- */
//
// Pinned as local consts so the wire ints are STABLE regardless of the
// `Network` enum's declaration order. A golden-vector test guards them; adding
// a value (a new format, a new kind) is an explicit, reviewed change here.

/** Format string → wire int. */
export const FORMAT_TO_CBOR: Readonly<Record<string, number>> = { "1.0": 1 }
/** Chain string → wire int. Matches `Network` *values*, pinned independently. */
export const CHAIN_TO_CBOR: Readonly<Record<string, number>> = {
  sandbox: 0,
  testnet: 1,
  mainnet: 2,
}
/** Kind → wire int. Only `"handshake"` today; later kinds add their own slot. */
export const KIND_TO_CBOR: Readonly<Record<HandshakeKind, number>> = { handshake: 0 }

const CBOR_TO_FORMAT = invert(FORMAT_TO_CBOR)
const CBOR_TO_CHAIN = invert(CHAIN_TO_CBOR)
const CBOR_TO_KIND = invert(KIND_TO_CBOR) as Readonly<Record<number, HandshakeKind>>

/* -------------------------------------------------------------------------- */
/*  CBOR map keys + byte sizes                                                */
/* -------------------------------------------------------------------------- */

const KEY_FORMAT = 1
const KEY_CHAIN = 2
const KEY_KIND = 3
const KEY_XMTP = 4
const KEY_UUID = 5
const KEY_STEALTH = 6
const KEY_L2 = 7
const KEY_TIME = 8
const KEY_TAG = 9

/** Every key the current wire format knows. An unknown key fails closed. */
const KNOWN_KEYS = new Set<number>([
  KEY_FORMAT,
  KEY_CHAIN,
  KEY_KIND,
  KEY_XMTP,
  KEY_UUID,
  KEY_STEALTH,
  KEY_L2,
  KEY_TIME,
  KEY_TAG,
])

const EVM_SIZE = 20 // bytes — Ethereum / XMTP-format address
const UUID_SIZE = 16 // bytes — per-share uuid
const AZTEC_SIZE = 32 // bytes — Aztec L2 address (field element)
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/* -------------------------------------------------------------------------- */
/*  Errors                                                                    */
/* -------------------------------------------------------------------------- */

/** The single opaque decode reject. No field detail escapes (fail-closed). */
export class HandshakeDecodeError extends Error {
  constructor() {
    super("Invalid handshake packet")
    this.name = "HandshakeDecodeError"
  }
}

/** Thrown by `encodeInline` when handed a packet it cannot represent. */
export class HandshakeEncodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HandshakeEncodeError"
  }
}

/* -------------------------------------------------------------------------- */
/*  Encode                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Encode a packet to a base64url(CBOR) string. Throws `HandshakeEncodeError`
 * if the packet can't be represented (unknown format/chain/kind, malformed or
 * zero address, malformed UUID) — the mint path is the only caller and a bad
 * mint should fail loudly, not ship a broken QR.
 */
export function encodeInline(packet: HandshakeInlinePacket): string {
  const { format, chain } = splitVersion(packet.version)
  const formatUint = FORMAT_TO_CBOR[format]
  if (formatUint === undefined) throw new HandshakeEncodeError(`Unknown format: ${format}`)
  const chainUint = CHAIN_TO_CBOR[chain]
  if (chainUint === undefined) throw new HandshakeEncodeError(`Unknown chain: ${chain}`)
  const kindUint = KIND_TO_CBOR[packet.kind]
  if (kindUint === undefined) throw new HandshakeEncodeError(`Unknown kind: ${packet.kind}`)

  const map = new Map<number, unknown>()
  map.set(KEY_FORMAT, formatUint)
  map.set(KEY_CHAIN, chainUint)
  map.set(KEY_KIND, kindUint)
  map.set(KEY_XMTP, evmToBytes(packet.xmtpHandle, HandshakeEncodeError))
  map.set(KEY_UUID, uuidToBytes(packet.uuid, HandshakeEncodeError))
  if (packet.stealthAddress !== undefined) {
    map.set(KEY_STEALTH, evmToBytes(packet.stealthAddress, HandshakeEncodeError))
  }
  if (packet.l2Address !== undefined) {
    map.set(KEY_L2, aztecToBytes(packet.l2Address, HandshakeEncodeError))
  }
  if (packet.time !== undefined) {
    if (!isWireTime(packet.time)) throw new HandshakeEncodeError("Invalid time")
    map.set(KEY_TIME, packet.time)
  }
  if (packet.tag !== undefined) map.set(KEY_TAG, asTag(packet.tag, HandshakeEncodeError))

  return toBase64Url(cborEncode(map))
}

/* -------------------------------------------------------------------------- */
/*  Decode                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Decode a base64url(CBOR) string to a packet, or throw `HandshakeDecodeError`.
 * Fail-closed: ANY problem (bad base64url/CBOR, unknown format/chain/kind int,
 * unknown map key, wrong byte length, missing required field, malformed/zero
 * address) yields the SAME opaque reject with no partial packet.
 */
export function decodeInline(b64url: string): HandshakeInlinePacket {
  try {
    return decodeStrict(b64url)
  } catch (err) {
    if (err instanceof HandshakeDecodeError) throw err
    // Any other throw (cbor-x, viem, AztecAddress, our reject) collapses to the
    // single opaque error so no field-level detail leaks.
    throw new HandshakeDecodeError()
  }
}

function decodeStrict(b64url: string): HandshakeInlinePacket {
  const bytes = fromBase64Url(b64url)

  let decoded: unknown
  try {
    decoded = cborDecode(bytes)
  } catch {
    throw new HandshakeDecodeError()
  }

  const keys = allKeys(decoded)
  for (const k of keys) {
    if (!KNOWN_KEYS.has(k)) throw new HandshakeDecodeError()
  }

  const format = CBOR_TO_FORMAT[asUint(readRequired(decoded, KEY_FORMAT))]
  const chain = CBOR_TO_CHAIN[asUint(readRequired(decoded, KEY_CHAIN))]
  const kind = CBOR_TO_KIND[asUint(readRequired(decoded, KEY_KIND))]
  if (format === undefined || chain === undefined || kind === undefined) {
    throw new HandshakeDecodeError()
  }

  const xmtpHandle = bytesToEvm(readRequired(decoded, KEY_XMTP))
  const uuid = bytesToUuid(readRequired(decoded, KEY_UUID))

  const packet: HandshakeInlinePacket = {
    version: `${format}:${chain}`,
    kind,
    xmtpHandle,
    uuid,
  }

  const stealth = readOptional(decoded, KEY_STEALTH)
  if (stealth !== undefined) packet.stealthAddress = bytesToEvm(stealth)

  const l2 = readOptional(decoded, KEY_L2)
  if (l2 !== undefined) packet.l2Address = bytesToAztec(l2)

  const time = readOptional(decoded, KEY_TIME)
  if (time !== undefined) {
    if (!isWireTime(time)) throw new HandshakeDecodeError()
    packet.time = time
  }

  const tag = readOptional(decoded, KEY_TAG)
  if (tag !== undefined) packet.tag = asTag(tag, HandshakeDecodeError)

  return packet
}

/* -------------------------------------------------------------------------- */
/*  Field reading (tolerant of Map or plain-object CBOR decode)               */
/* -------------------------------------------------------------------------- */
//
// cbor-x may decode a CBOR map to a Map or to a plain object depending on its
// options; integer keys become string object keys under the plain-object path.
// These helpers read either shape so the codec is independent of that default.

function allKeys(decoded: unknown): number[] {
  if (decoded instanceof Map) {
    return [...decoded.keys()].map(toKeyNumber)
  }
  if (decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)) {
    return Object.keys(decoded).map(toKeyNumber)
  }
  throw new HandshakeDecodeError()
}

function toKeyNumber(k: unknown): number {
  const n = Number(k)
  if (!Number.isInteger(n)) throw new HandshakeDecodeError()
  return n
}

function readField(decoded: unknown, key: number): unknown {
  if (decoded instanceof Map) return decoded.get(key)
  if (decoded !== null && typeof decoded === "object") {
    return (decoded as Record<string, unknown>)[String(key)]
  }
  throw new HandshakeDecodeError()
}

function readRequired(decoded: unknown, key: number): unknown {
  const value = readField(decoded, key)
  if (value === undefined || value === null) throw new HandshakeDecodeError()
  return value
}

function readOptional(decoded: unknown, key: number): unknown {
  const value = readField(decoded, key)
  return value === null ? undefined : value
}

/* -------------------------------------------------------------------------- */
/*  Byte <-> string conversions (canonical, zero-rejecting)                   */
/* -------------------------------------------------------------------------- */

function evmToBytes(addr: string, Err: ErrCtor): Uint8Array {
  let checked: `0x${string}`
  try {
    checked = getAddress(addr)
  } catch {
    throw new Err("Invalid EVM address")
  }
  const bytes = hexToBytes(checked)
  if (bytes.length !== EVM_SIZE || isAllZero(bytes)) throw new Err("Invalid EVM address")
  return bytes
}

function bytesToEvm(value: unknown): string {
  const bytes = asBytes(value, EVM_SIZE)
  if (isAllZero(bytes)) throw new HandshakeDecodeError()
  // bytesToHex → lowercase; getAddress → canonical EIP-55 checksum.
  return getAddress(bytesToHex(bytes))
}

function aztecToBytes(addr: string, Err: ErrCtor): Uint8Array {
  let a: AztecAddress
  try {
    a = AztecAddress.fromStringUnsafe(addr)
  } catch {
    throw new Err("Invalid L2 address")
  }
  if (a.isZero()) throw new Err("Invalid L2 address")
  return Uint8Array.from(a.toBuffer())
}

function bytesToAztec(value: unknown): string {
  const bytes = asBytes(value, AZTEC_SIZE)
  let a: AztecAddress
  try {
    a = AztecAddress.fromBuffer(Buffer.from(bytes))
  } catch {
    throw new HandshakeDecodeError()
  }
  if (a.isZero()) throw new HandshakeDecodeError()
  return a.toString()
}

/**
 * The tag's only validator, so it must reject rather than sanitize. `verifyTag` folds an invalid
 * tag into "unregistered" (`registryResolution.ts`), which would skip the registry cross-check
 * entirely and store a payment route under a homograph.
 */
function asTag(value: unknown, Err: ErrCtor): string {
  if (typeof value !== "string" || normalizeTag(value) !== value) {
    throw new Err("Invalid tag")
  }
  return value
}

function uuidToBytes(uuid: string, Err: ErrCtor): Uint8Array {
  if (typeof uuid !== "string" || !UUID_V4.test(uuid)) {
    throw new Err("Invalid uuid (expected UUID v4)")
  }
  return hexToBytes(`0x${uuid.replaceAll("-", "").toLowerCase()}`)
}

function bytesToUuid(value: unknown): string {
  const hex = bytesToHex(asBytes(value, UUID_SIZE)).slice(2)
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`
  if (!UUID_V4.test(uuid)) throw new HandshakeDecodeError()
  return uuid
}

/* -------------------------------------------------------------------------- */
/*  Primitives                                                                */
/* -------------------------------------------------------------------------- */

type ErrCtor = new (message: string) => Error

function asBytes(value: unknown, expectedLen: number): Uint8Array {
  // Buffer is a Uint8Array subclass, so this also accepts cbor-x's Node output.
  if (!(value instanceof Uint8Array)) throw new HandshakeDecodeError()
  if (value.length !== expectedLen) throw new HandshakeDecodeError()
  return value
}

function asUint(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new HandshakeDecodeError()
  }
  return value
}

function isWireTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function isAllZero(bytes: Uint8Array): boolean {
  for (const b of bytes) if (b !== 0) return false
  return true
}

function splitVersion(version: string): { format: string; chain: string } {
  if (typeof version !== "string") throw new HandshakeEncodeError("Invalid version")
  const idx = version.indexOf(":")
  if (idx <= 0 || idx === version.length - 1) throw new HandshakeEncodeError("Invalid version")
  return { format: version.slice(0, idx), chain: version.slice(idx + 1) }
}

function invert(map: Readonly<Record<string, number>>): Readonly<Record<number, string>> {
  const out: Record<number, string> = {}
  for (const [k, v] of Object.entries(map)) out[v] = k
  return out
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
  if (typeof b64url !== "string" || b64url.length === 0) throw new HandshakeDecodeError()
  // Reject anything outside the base64url alphabet up front — `Buffer.from(…,
  // "base64")` is lenient and would silently drop stray characters.
  if (!/^[A-Za-z0-9_-]+$/.test(b64url)) throw new HandshakeDecodeError()
  let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/")
  while (b64.length % 4) b64 += "="
  return Uint8Array.from(Buffer.from(b64, "base64"))
}
