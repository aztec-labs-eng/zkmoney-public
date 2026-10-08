/**
 * The hand-off material's contract (`v: 1`): what a web campaign seals for the wallet (`sealed.ts`).
 * Both web fronts consume this one contract.
 */

import type { PrfSlot } from "@obsidion/core/types"

export const BRIDGE_VERSION = 1
export const MATERIAL_TYPE = "handoff-material"

/** Every PRF candidate the campaign evaluated, as `0x` + 64 hex, each below the scalar field order. */
export type BridgeCandidates = { first?: string; second?: string }

export type BridgeMessage = {
  v: typeof BRIDGE_VERSION
  type: typeof MATERIAL_TYPE
  /** Short opaque token naming this hand-off. */
  nonce: string
  /** The campaign's own ceremony time, epoch ms; the wallet bounds its age at the attempt. */
  derivedAt: number
  /** The passkey's relying party; the wallet refuses another wallet's. */
  rpId: string
  /** base64url credential id. */
  credentialId: string
  /** Raw 64-byte `x||y` public key, 128 hex, no `0x`. */
  pubkeyHex: string
  candidates: BridgeCandidates
  /** The slot the campaign's own account is derived from, one of the candidates above. */
  slot?: PrfSlot
  /**
   * The transports the creation response reported, when the campaign has them: the wallet's
   * record of how the authenticator is reached, never filtered here.
   */
  transports?: readonly string[]
}

/** BN254's scalar field order: the master key is an `Fr`, so a candidate at or above it is no key. */
export const BN254_SCALAR_FIELD_ORDER =
  0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n

export type BridgeRejection =
  | "not-an-object"
  | "version"
  | "type"
  | "nonce"
  | "derivedAt"
  | "rpId"
  | "credentialId"
  | "pubkeyHex"
  | "candidates"
  | "candidate-hex"
  | "candidate-order"
  | "slot"
  | "transports"

export type BridgeVerdict =
  | { ok: true; message: BridgeMessage }
  | { ok: false; reason: BridgeRejection }

const NONCE = /^[A-Za-z0-9_-]{1,64}$/
/** A credential id is at most 1023 bytes (WebAuthn), 1364 characters as base64url. */
const BASE64URL = /^[A-Za-z0-9_-]{1,1364}$/
const HEX_128 = /^[0-9a-fA-F]{128}$/
const FIELD_HEX = /^0x[0-9a-fA-F]{64}$/
/** A WebAuthn transport token; the browser may report one the wallet has never seen. */
const TRANSPORT = /^[a-z][a-z0-9-]{0,15}$/
const MAX_TRANSPORTS = 8

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * A non-empty, bounded list of transport tokens: the one shape the wire and the stored material
 * admit. Checked over a dense copy, so a hole counts as a non-token.
 */
export const isTransportList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= MAX_TRANSPORTS &&
  Array.from(value).every((t) => typeof t === "string" && TRANSPORT.test(t))

/** Shape checks only; the wallet's anchors decide what the material is worth. */
export function validateBridgeMessage(input: unknown, expected: { rpId: string }): BridgeVerdict {
  if (!isRecord(input)) return { ok: false, reason: "not-an-object" }
  if (input.v !== BRIDGE_VERSION) return { ok: false, reason: "version" }
  if (input.type !== MATERIAL_TYPE) return { ok: false, reason: "type" }
  if (typeof input.nonce !== "string" || !NONCE.test(input.nonce)) {
    return { ok: false, reason: "nonce" }
  }
  if (
    typeof input.derivedAt !== "number" ||
    !Number.isSafeInteger(input.derivedAt) ||
    input.derivedAt <= 0
  ) {
    return { ok: false, reason: "derivedAt" }
  }
  if (input.rpId !== expected.rpId) return { ok: false, reason: "rpId" }
  if (typeof input.credentialId !== "string" || !BASE64URL.test(input.credentialId)) {
    return { ok: false, reason: "credentialId" }
  }
  if (typeof input.pubkeyHex !== "string" || !HEX_128.test(input.pubkeyHex)) {
    return { ok: false, reason: "pubkeyHex" }
  }
  if (!isRecord(input.candidates)) return { ok: false, reason: "candidates" }
  const candidates: BridgeCandidates = {}
  for (const slot of ["first", "second"] as const) {
    const value = input.candidates[slot]
    if (value === undefined) continue
    if (typeof value !== "string" || !FIELD_HEX.test(value)) {
      return { ok: false, reason: "candidate-hex" }
    }
    if (BigInt(value) >= BN254_SCALAR_FIELD_ORDER) return { ok: false, reason: "candidate-order" }
    candidates[slot] = value
  }
  if (!candidates.first && !candidates.second) return { ok: false, reason: "candidates" }
  const slot = input.slot
  if (slot !== undefined && ((slot !== "first" && slot !== "second") || !candidates[slot])) {
    return { ok: false, reason: "slot" }
  }
  if (input.transports !== undefined && !isTransportList(input.transports)) {
    return { ok: false, reason: "transports" }
  }
  return {
    ok: true,
    message: {
      v: BRIDGE_VERSION,
      type: MATERIAL_TYPE,
      nonce: input.nonce,
      derivedAt: input.derivedAt,
      rpId: input.rpId,
      credentialId: input.credentialId,
      pubkeyHex: input.pubkeyHex,
      candidates,
      ...(slot ? { slot } : {}),
      ...(input.transports ? { transports: [...input.transports] } : {}),
    },
  }
}
