/**
 * The passkey a tag's account installed, read back from L1 so a browser that cannot enumerate the
 * passkey can ask for it by credential id. Registration writes each installed r1 key with the
 * credential id's raw bytes as `metadata` (`credentialIdToMetadata`); this is the inverse, plus the
 * rule for which entries count as candidates. Nothing here is trusted: the caller pins the
 * credential and the anchors still decide which account the passkey opens.
 */

import type { Address, Hex } from "viem"
import type { AuthKeyEntry } from "@oxide/l1-contracts"

import {
  TagValidationError,
  type RegistryTagResolution,
} from "../core/services/RegistryTagResolver"
import type { BoundedAuthKeys } from "./oxideRegistration"

/** A credential id shorter than this is not one any admitted authenticator mints. */
const MIN_CREDENTIAL_ID_BYTES = 16
/** WebAuthn's ceiling on a credential id. */
const MAX_CREDENTIAL_ID_BYTES = 1023
/** Output cap, and the bound the caller's key read should honour. */
export const MAX_PASSKEY_CANDIDATES = 8

/** What the pinned assertion needs: the id to ask for and the key the answer must carry. */
export interface PasskeyCredentialCandidate {
  /** base64url, no padding — the form WebAuthn and the identity map use. */
  credentialId: string
  /** Raw 64-byte `x‖y` as lowercase hex without `0x`, the form the auth service compares. */
  pubkeyHex: string
}

export type PasskeyCredentialsByTag =
  | {
      kind: "resolved"
      account: Address
      l2Address: string
      /** In on-chain order, at most {@link MAX_PASSKEY_CANDIDATES}. */
      candidates: PasskeyCredentialCandidate[]
      /** Whether the read covered every installed key: false when the account has more than were read. */
      complete: boolean
      /** The account's total installed key count, eligible or not. */
      authKeyCount: number
    }
  /** Unregistered or invalid tag. */
  | { kind: "notFound" }
  /** Registered on an earlier rollup version. */
  | { kind: "staleRollup" }
  /** The account holds no auth key. */
  | { kind: "noKeyInstalled"; account: Address }
  /** Keys exist, none read carries an eligible credential id; `complete` says whether more went unread. */
  | { kind: "unreadable"; account: Address; complete: boolean }

export interface PasskeyCredentialsByTagDeps {
  resolveTag: (tag: string) => Promise<RegistryTagResolution>
  /** The counted key read, expected to return at most {@link MAX_PASSKEY_CANDIDATES} entries. */
  readAuthKeys: (account: Address) => Promise<BoundedAuthKeys>
}

/**
 * The byte inverse of `credentialIdToMetadata`: raw bytes as `0x`-hex → base64url without padding.
 * Throws on empty, unprefixed or malformed hex. Eligibility is not judged here.
 */
export function metadataToCredentialId(metadata: Hex): string {
  const raw = metadata.startsWith("0x") ? metadata.slice(2) : undefined
  if (!raw || raw.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(raw)) {
    throw new Error("metadataToCredentialId: not a non-empty 0x-hex byte string")
  }
  // Some Buffer polyfills lack the "base64url" encoding, so go through "base64" and swap.
  return Buffer.from(raw, "hex")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

/** The entry's key as raw 64-byte `x‖y` lowercase hex without `0x`, or undefined when it is not 64 bytes. */
export function authKeyPubkeyHex(entry: AuthKeyEntry): string | undefined {
  const pubkeyHex = `${entry.key.qx.slice(2)}${entry.key.qy.slice(2)}`.toLowerCase()
  return pubkeyHex.length === 128 ? pubkeyHex : undefined
}

/** The entry as a candidate, or undefined when its metadata is not an eligible credential id. */
export function authKeyToCandidate(entry: AuthKeyEntry): PasskeyCredentialCandidate | undefined {
  // Bounds first: an oversized entry is never decoded.
  const bytes = (entry.metadata.length - 2) / 2
  if (bytes < MIN_CREDENTIAL_ID_BYTES || bytes > MAX_CREDENTIAL_ID_BYTES) return undefined
  let credentialId: string
  try {
    credentialId = metadataToCredentialId(entry.metadata)
  } catch {
    return undefined
  }
  const pubkeyHex = authKeyPubkeyHex(entry)
  if (!pubkeyHex) return undefined
  return { credentialId, pubkeyHex }
}

/**
 * Tag → the account's passkey candidates. A `TagValidationError` is `notFound`; transport failures
 * from either read propagate. Scans the returned keys in order, skipping ineligible entries, until
 * it holds {@link MAX_PASSKEY_CANDIDATES} or the array ends.
 */
export async function readPasskeyCredentialsByTag(
  tag: string,
  deps: PasskeyCredentialsByTagDeps,
): Promise<PasskeyCredentialsByTag> {
  let resolution: RegistryTagResolution
  try {
    resolution = await deps.resolveTag(tag)
  } catch (err) {
    if (err instanceof TagValidationError) return { kind: "notFound" }
    throw err
  }
  if (resolution.status === "notFound") return { kind: "notFound" }
  if (resolution.status === "staleRollup") return { kind: "staleRollup" }

  const account = resolution.account as Address
  const { entries, authKeyCount } = await deps.readAuthKeys(account)
  if (authKeyCount === 0) return { kind: "noKeyInstalled", account }
  // The read covered every key only when the account holds no more than were returned.
  const complete = authKeyCount <= entries.length

  const candidates: PasskeyCredentialCandidate[] = []
  for (const entry of entries) {
    if (candidates.length >= MAX_PASSKEY_CANDIDATES) break
    const candidate = authKeyToCandidate(entry)
    if (candidate) candidates.push(candidate)
  }
  if (candidates.length === 0) return { kind: "unreadable", account, complete }
  return {
    kind: "resolved",
    account,
    l2Address: resolution.l2Address,
    candidates,
    complete,
    authKeyCount,
  }
}
