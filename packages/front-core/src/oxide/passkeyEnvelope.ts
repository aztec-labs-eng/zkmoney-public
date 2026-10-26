/**
 * The backup passkey's envelope: the wallet master key sealed under the passkey's PRF output, stored
 * as the key's auth-key metadata on the oxide account. A backup passkey opens the wallet on any
 * device by decrypting it, where a root passkey derives the master key from its PRF.
 *
 * Envelope v1: `version(1)=0x01 ‖ slot(1) ‖ nonce(12) ‖ ciphertext(32) ‖ tag(16)`. The key is
 * HKDF-SHA256 over the PRF output, the cipher AES-256-GCM, the AAD the account and the credential
 * id, so an envelope opens only for the passkey and account it was sealed for. The slot byte is the
 * sealing slot: the opener's first try, not its only one, since some providers hand the platform
 * `second` output back as the cross-device `first`. A sign-up passkey's PRF output is what its
 * wallet's master key is derived from, so a passkey is never both a sign-up key and a backup key:
 * the flow that adds a backup refuses one that roots a registered account before it seals.
 *
 * On chain the envelope sits behind oxide's metadata prefix, `0x01 ‖ keccak256(tag ‖ credential id)`
 * (`oxide-client/passkey_rotation.ts`), and the raw credential id follows it, so a sign-in by tag
 * can name a passkey the browser cannot list. The prefix is copied here because the module defining
 * it cannot be imported at runtime; the drift test pins the copy to oxide's own output. The sign-up
 * passkey keeps its raw credential id as metadata, so the readers accept both layouts.
 */

import type { PrfSlot } from "@obsidion/core/types"
import {
  type Address,
  type Hex,
  bytesToHex,
  concat,
  hexToBytes,
  keccak256,
  stringToHex,
} from "viem"

import { credentialIdToMetadata, metadataToCredentialId } from "./oxideWebAuthn"

export const PASSKEY_ENVELOPE_VERSION = 0x01
export const PASSKEY_ENVELOPE_BYTES = 62

const NONCE_BYTES = 12
const MASTER_KEY_BYTES = 32
const PRF_BYTES = 32
const KEK_INFO = new TextEncoder().encode("zk.money/passkey-envelope/v1")

const SLOT_BYTE: Record<PrfSlot, number> = { first: 0x00, second: 0x01 }

/** The metadata version and credential-id tag of `oxide-client/passkey_rotation.ts`. */
const METADATA_VERSION: Hex = "0x01"
const CREDENTIAL_ID_TAG = stringToHex("oxide.passkey.credential-id.v1")
const METADATA_PREFIX_BYTES = 33

const MIN_CREDENTIAL_ID_BYTES = 16
const MAX_CREDENTIAL_ID_BYTES = 1023

export type PasskeyEnvelopeFailure = "version" | "decrypt" | "unverified"

/** The envelope did not open: unknown layout, wrong key or AAD, or an assertion without user verification. */
export class PasskeyEnvelopeError extends Error {
  constructor(readonly reason: PasskeyEnvelopeFailure, message = `passkey envelope: ${reason}`) {
    super(message)
    this.name = "PasskeyEnvelopeError"
  }
}

export interface SealMasterKeyInput {
  /** 32 bytes, the master key as `Fr` big-endian. */
  masterKey: Uint8Array
  /** 32 bytes, the backup passkey's PRF output in `slot`. */
  prfOutput: Uint8Array
  slot: PrfSlot
  /** The oxide account the key is installed on (AAD). */
  account: Address
  /** base64url, the backup passkey's (AAD). */
  credentialId: string
}

export interface OpenMasterKeyInput {
  envelope: Uint8Array
  /** Every PRF output the assertion returned; the header's slot is tried first, the other next. */
  prf: { first?: Uint8Array; second?: Uint8Array }
  account: Address
  credentialId: string
}

/** Seal the master key under the PRF output; a fresh nonce each call. Returns the 62-byte envelope. */
export async function sealMasterKey(input: SealMasterKeyInput): Promise<Uint8Array> {
  expectLength("masterKey", input.masterKey, MASTER_KEY_BYTES)
  expectLength("prfOutput", input.prfOutput, PRF_BYTES)
  if (!(input.slot in SLOT_BYTE)) throw new Error(`sealMasterKey: unknown slot ${input.slot}`)
  const aad = additionalData(input.account, input.credentialId)
  const key = await keyEncryptionKey(input.prfOutput)
  const nonce = subtle().getRandomValues(new Uint8Array(NONCE_BYTES))
  const sealed = new Uint8Array(
    await subtle().subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad },
      key,
      input.masterKey,
    ),
  )
  const envelope = new Uint8Array(PASSKEY_ENVELOPE_BYTES)
  envelope[0] = PASSKEY_ENVELOPE_VERSION
  envelope[1] = SLOT_BYTE[input.slot]
  envelope.set(nonce, 2)
  envelope.set(sealed, 2 + NONCE_BYTES)
  return envelope
}

/**
 * Open the envelope with the PRF outputs the assertion returned. The header's slot is tried first and
 * the other present slot next; GCM rejects a wrong key, so the second try admits nothing. Throws
 * `PasskeyEnvelopeError("version")` for an unknown layout and `("decrypt")` when no output opens it.
 */
export async function openMasterKey(input: OpenMasterKeyInput): Promise<Uint8Array> {
  const headerSlot = envelopeSlot(input.envelope)
  const otherSlot: PrfSlot = headerSlot === "first" ? "second" : "first"
  const tries = [input.prf[headerSlot], input.prf[otherSlot]].filter(
    (prf): prf is Uint8Array => prf !== undefined,
  )
  for (const prf of tries) expectLength("prf", prf, PRF_BYTES)
  const aad = additionalData(input.account, input.credentialId)
  const nonce = input.envelope.subarray(2, 2 + NONCE_BYTES)
  const sealed = input.envelope.subarray(2 + NONCE_BYTES)
  for (const prf of tries) {
    const key = await keyEncryptionKey(prf)
    try {
      return new Uint8Array(
        await subtle().subtle.decrypt(
          { name: "AES-GCM", iv: nonce, additionalData: aad },
          key,
          sealed,
        ),
      )
    } catch {
      // A wrong key or AAD fails the tag check; the next output may still open it.
    }
  }
  throw new PasskeyEnvelopeError("decrypt")
}

/** The slot the envelope was sealed under, from its header; any other layout is `PasskeyEnvelopeError("version")`. */
export function envelopeSlot(envelope: Uint8Array): PrfSlot {
  if (envelope.length !== PASSKEY_ENVELOPE_BYTES || envelope[0] !== PASSKEY_ENVELOPE_VERSION) {
    throw new PasskeyEnvelopeError("version")
  }
  if (envelope[1] === SLOT_BYTE.first) return "first"
  if (envelope[1] === SLOT_BYTE.second) return "second"
  throw new PasskeyEnvelopeError("version")
}

/** `keccak256("oxide.passkey.credential-id.v1" ‖ id bytes)`, the hash oxide's metadata prefix carries. */
export function credentialIdHash(credentialId: string): Hex {
  return keccak256(concat([CREDENTIAL_ID_TAG, credentialIdToMetadata(credentialId)]))
}

export type ParsedKeyMetadata =
  /** The sign-up passkey's raw credential id. */
  | { kind: "credential-id"; credentialId: string }
  /**
   * Oxide's layout: `0x01 ‖ hash ‖ envelope [‖ credential id]`. The envelope is unvalidated: the
   * first 62 bytes after the prefix, or all of them when fewer. The id is present only when the
   * bytes after the envelope hash to the prefix.
   */
  | {
      kind: "envelope-prefixed"
      credentialIdHash: Hex
      envelope: Uint8Array
      /** base64url. */
      credentialId?: string
    }
  | { kind: "unknown" }

/** Classify an auth key's metadata by length and first byte only. */
export function parseKeyMetadata(metadata: Hex): ParsedKeyMetadata {
  const bytes = hexToBytes(metadata)
  const prefixed = splitPasskeyMetadata(bytes)
  if (prefixed) return prefixed
  if (bytes.length >= MIN_CREDENTIAL_ID_BYTES && bytes.length <= MAX_CREDENTIAL_ID_BYTES) {
    return { kind: "credential-id", credentialId: metadataToCredentialId(bytesToHex(bytes)) }
  }
  return { kind: "unknown" }
}

/**
 * How an entry's metadata names the assertion's credential: `"raw"` when it is the id's own bytes
 * (the root path), `"hash"` when oxide's prefix carries the id's hash (the envelope path). Raw
 * equality is tried first, so a raw id that happens to look prefixed still signs in as a root.
 */
export function matchKind(metadata: Hex, credentialId: string): "raw" | "hash" | undefined {
  if (metadata.toLowerCase() === credentialIdToMetadata(credentialId)) return "raw"
  const parsed = parseKeyMetadata(metadata)
  if (
    parsed.kind === "envelope-prefixed" &&
    parsed.credentialIdHash === credentialIdHash(credentialId)
  ) {
    return "hash"
  }
  return undefined
}

function splitPasskeyMetadata(
  bytes: Uint8Array,
): Extract<ParsedKeyMetadata, { kind: "envelope-prefixed" }> | undefined {
  if (
    bytes.length < METADATA_PREFIX_BYTES ||
    bytesToHex(bytes.subarray(0, 1)) !== METADATA_VERSION
  ) {
    return undefined
  }
  const credentialIdHash = bytesToHex(bytes.subarray(1, METADATA_PREFIX_BYTES))
  const payload = bytes.slice(METADATA_PREFIX_BYTES)
  if (payload.length < PASSKEY_ENVELOPE_BYTES) {
    return { kind: "envelope-prefixed", credentialIdHash, envelope: payload }
  }
  const envelope = payload.slice(0, PASSKEY_ENVELOPE_BYTES)
  const tail = bytesToHex(payload.subarray(PASSKEY_ENVELOPE_BYTES))
  const tailBytes = payload.length - PASSKEY_ENVELOPE_BYTES
  const appended =
    tailBytes >= MIN_CREDENTIAL_ID_BYTES &&
    tailBytes <= MAX_CREDENTIAL_ID_BYTES &&
    keccak256(concat([CREDENTIAL_ID_TAG, tail])) === credentialIdHash
  return {
    kind: "envelope-prefixed",
    credentialIdHash,
    envelope,
    ...(appended ? { credentialId: metadataToCredentialId(tail) } : {}),
  }
}

function additionalData(account: Address, credentialId: string): Uint8Array {
  const accountBytes = hexToBytes(account)
  if (accountBytes.length !== 20) {
    throw new Error(`passkeyEnvelope: account must be 20 bytes, got ${accountBytes.length}`)
  }
  return concatBytes(accountBytes, hexToBytes(credentialIdToMetadata(credentialId)))
}

async function keyEncryptionKey(prfOutput: Uint8Array): Promise<CryptoKey> {
  const { subtle: s } = subtle()
  const ikm = await s.importKey("raw", prfOutput, "HKDF", false, ["deriveBits"])
  const bits = await s.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: KEK_INFO },
    ikm,
    256,
  )
  return s.importKey("raw", bits, "AES-GCM", false, ["encrypt", "decrypt"])
}

function subtle(): Crypto {
  const c = globalThis.crypto
  if (!c?.subtle) throw new Error("passkeyEnvelope: crypto.subtle is unavailable")
  return c
}

function expectLength(name: string, bytes: Uint8Array, length: number): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw new Error(`passkeyEnvelope: ${name} must be ${length} bytes`)
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}
