import { ZERO_AAGUID } from "@obsidion/core/constants"

/**
 * The flags byte of a WebAuthn `authenticatorData` buffer (Level 3 §6.1: 32-byte rpIdHash, then
 * flags, then a 4-byte counter). Backup-eligible is the wallet's credential class: unset means a
 * device-bound key that no other device can ever read.
 */
export type AuthenticatorDataFlags = {
  backupEligible: boolean
  backupState: boolean
  attestedCredentialData: boolean
}

const FLAGS_OFFSET = 32
const MIN_LENGTH = 37
const FLAG_BE = 0x08
const FLAG_BS = 0x10
const FLAG_AT = 0x40
const AAGUID_OFFSET = 37
const AAGUID_LENGTH = 16

/**
 * The provider's self-reported AAGUID from a registration response's attested-credential block
 * (16 bytes right after the counter), as a lowercase hyphenated UUID. `undefined` when the buffer
 * carries no attested data or the id is all zeros, which some browsers report under
 * `attestation: "none"`: both mean "unknown provider", never a match.
 */
export function parseAaguid(authenticatorData: Uint8Array): string | undefined {
  const aaguid = parseAttestedAaguid(authenticatorData)
  return aaguid === ZERO_AAGUID ? undefined : aaguid
}

/**
 * The AAGUID as attested, all zeros included, so a provider that did not report itself can be told
 * from a response with no attested data. `undefined` only in the second case.
 */
export function parseAttestedAaguid(authenticatorData: Uint8Array): string | undefined {
  if (authenticatorData.length < AAGUID_OFFSET + AAGUID_LENGTH) return undefined
  if (!parseAuthenticatorDataFlags(authenticatorData).attestedCredentialData) return undefined
  const bytes = authenticatorData.subarray(AAGUID_OFFSET, AAGUID_OFFSET + AAGUID_LENGTH)
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  const cuts = [8, 12, 16, 20]
  return [0, ...cuts].map((start, i) => hex.slice(start, cuts[i])).join("-")
}

/** Throws on a buffer too short to carry the flags; callers treat that as "unknown" and fail closed. */
export function parseAuthenticatorDataFlags(authenticatorData: Uint8Array): AuthenticatorDataFlags {
  if (authenticatorData.length < MIN_LENGTH) {
    throw new Error(
      `authenticatorData is ${authenticatorData.length} bytes; the flags need at least ${MIN_LENGTH}`,
    )
  }
  const flags = authenticatorData[FLAGS_OFFSET]!
  return {
    backupEligible: (flags & FLAG_BE) !== 0,
    backupState: (flags & FLAG_BS) !== 0,
    attestedCredentialData: (flags & FLAG_AT) !== 0,
  }
}
