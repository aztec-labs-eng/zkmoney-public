/**
 * "Find my passkey by tag": the tag's installed keys read from L1, for a sign-in pinned to its
 * account, and the reading of a pinned sign-in that no anchor named. Nothing here decides who
 * enters; `enterWithPasskey`'s anchors do.
 */
import {
  MAX_PASSKEY_CANDIDATES,
  answeringKey,
  createOxideL1Reader,
  readPasskeyCredentialsByTag,
  type InstalledPasskey,
  type PasskeyCredentialsByTag,
} from "@obsidion/front-core"
import type { Address } from "viem"
import { getConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"
import { resolveSignInTagForCommit } from "../contacts/registryResolution"
import type { EnterResult } from "./oxideOnboarding"

export type PasskeyByTagLookup =
  | {
      kind: "resolved"
      tag: string
      account: Address
      l2Address: string
      /** Every key read, in on-chain order. */
      keys: InstalledPasskey[]
      /** The account holds keys beyond the first, readable or not. */
      moreKeys: boolean
    }
  /** The account holds more keys than this read covers, so no sign-in can derive its address. */
  | { kind: "inconclusive"; tag: string; account: Address }
  | Exclude<PasskeyCredentialsByTag, { kind: "resolved" }>

const readByTag = (tag: string, resolveTag: typeof resolveSignInTagForCommit) => {
  const l1 = createOxideL1Reader(l1PublicClient(getConfig()))
  return readPasskeyCredentialsByTag(tag, {
    resolveTag,
    readAuthKeys: (account) => l1.readAuthKeysCounted(account, MAX_PASSKEY_CANDIDATES),
  })
}

/**
 * The tag's keys from L1. `resolveTag` defaults to the commit-time resolver (a fresh manifest);
 * a type-ahead caller passes `resolveSignInTag`, which reads over the cached tuple. A read that
 * cannot reach the chain throws.
 */
export async function lookupPasskeyByTag(
  tag: string,
  options?: { resolveTag?: typeof resolveSignInTagForCommit },
): Promise<PasskeyByTagLookup> {
  const read = await readByTag(tag, options?.resolveTag ?? resolveSignInTagForCommit)
  if (read.kind !== "resolved") return read
  if (!read.complete) return { kind: "inconclusive", tag, account: read.account }
  return {
    kind: "resolved",
    tag,
    account: read.account,
    l2Address: read.l2Address,
    keys: read.keys,
    moreKeys: read.authKeyCount > 1,
  }
}

/** What a missed attempt carries so a tag read can say whether that passkey belongs to the account. */
export interface MissEvidence {
  credentialId: string
  /** The settled signing key, as lowercase hex (with or without `0x`). */
  pubkey: string
  /** Every address the attempt's candidates derived. */
  addresses: readonly string[]
}

/**
 * The verdict of a tag diagnosis, most helpful first. It is deliberately conservative: the chain
 * marks no root, so a listed key that reproduces nothing cannot be told apart from a non-root
 * signing key — `NOT_REPRODUCED_HERE`, never a divergence claim. The pass-through kinds are the
 * by-tag notices a lookup already surfaces.
 */
export type MissDiagnosis =
  /** The passkey derives the tag's account but the sign-in's anchor probe lagged this read; retry. */
  | "REGISTRY_UNANCHORED"
  /** The passkey is listed for the tag, but this attempt did not open it; try the phone or a key. */
  | "NOT_REPRODUCED_HERE"
  /** The passkey is not among the tag's complete set of installed keys. */
  | "DIFFERENT_PASSKEY"
  /** The account has more keys than could be read, so membership cannot be settled. */
  | "INCONCLUSIVE"
  | "notFound"
  | "staleRollup"
  | "noKeyInstalled"
  | "unreadable"

/**
 * Given the tag the user typed and the evidence of the attempt that missed, say whether this
 * passkey belongs to the tag's account — with one L1 read and no second ceremony. The entry that
 * counts answers for the credential id (by its raw id or by the hash oxide's prefix carries) AND
 * carries its public key; a matched entry that reproduces the account is a lagged registry probe,
 * one that does not is not-reproduced-here. It never asserts the strong "this computer returned
 * the wrong key" — only the record-anchored path can.
 */
export async function diagnoseMiss(evidence: MissEvidence, tag: string): Promise<MissDiagnosis> {
  const read = await readByTag(tag, resolveSignInTagForCommit)
  if (read.kind === "unreadable") return read.complete ? "unreadable" : "INCONCLUSIVE"
  if (read.kind !== "resolved") return read.kind
  const wantedKey = evidence.pubkey.toLowerCase().replace(/^0x/, "")
  const answer = answeringKey(read.keys, evidence.credentialId)
  const match = answer && answer.key.pubkeyHex === wantedKey
  if (!match) return read.complete ? "DIFFERENT_PASSKEY" : "INCONCLUSIVE"
  const account = read.l2Address.toLowerCase()
  const reproduces = evidence.addresses.some((a) => a.toLowerCase() === account)
  return reproduces ? "REGISTRY_UNANCHORED" : "NOT_REPRODUCED_HERE"
}

export type UnknownDiagnosis =
  | "REGISTRY_UNANCHORED"
  | "PASSKEY_KEY_MISMATCH"
  /** This computer's own copy of the account's one key returned the wrong PRF value. */
  | "LOCAL_COPY_WRONG_KEY"

/** What the pinned attempt knew besides its result, for the wrong-key verdict. */
export interface PinnedEvidence {
  laptop: boolean
  /** The account holds keys beyond the one pinned, or no read could say. */
  moreKeys: boolean
}

/**
 * Why a pinned sign-in ended `unknown`: a candidate derives the tag's account but no anchor named
 * it (the record could not be confirmed; worth a retry); nothing the passkey derives is the tag's
 * account, which includes this browser's own record for the credential no longer reproducing; or,
 * with `evidence`, this computer's own copy returned the wrong key. That last verdict needs no
 * record: the pin checked the answer's key against the account's installed key, so when this
 * computer answered, both slots were evaluated, and the account holds no other key that could be
 * its root, nothing is left to be wrong but the PRF value.
 */
export function diagnoseUnknown(
  result: Extract<EnterResult, { reason: "unknown" }>,
  l2Address: string,
  evidence?: PinnedEvidence,
): UnknownDiagnosis {
  if (result.storedAddressMismatch) return "PASSKEY_KEY_MISMATCH"
  const wanted = l2Address.toLowerCase()
  const derivesIt = result.addresses?.some((address) => address.toLowerCase() === wanted)
  if (derivesIt) return "REGISTRY_UNANCHORED"
  const localCopyWrongKey =
    evidence?.laptop === true &&
    !evidence.moreKeys &&
    result.observed?.attachment === "platform" &&
    (result.addresses?.length ?? 0) >= 2
  return localCopyWrongKey ? "LOCAL_COPY_WRONG_KEY" : "PASSKEY_KEY_MISMATCH"
}

/** The analytics code of each by-tag terminal outcome and diagnosis, keyed on the outcome, never on a display row. */
export const BY_TAG_FAILURE_CODES = {
  notFound: "bytag_tag_not_found",
  staleRollup: "bytag_stale_rollup",
  noKeyInstalled: "bytag_no_key_installed",
  unreadable: "bytag_key_unreadable",
  lookupFailed: "bytag_lookup_failed",
  promptClosed: "passkey_not_on_device",
  wrongCredential: "passkey_wrong_credential",
  REGISTRY_UNANCHORED: "registry_unanchored",
  PASSKEY_KEY_MISMATCH: "passkey_key_mismatch",
  LOCAL_COPY_WRONG_KEY: "bytag_local_copy_wrong_key",
  NOT_REPRODUCED_HERE: "bytag_not_reproduced_here",
  DIFFERENT_PASSKEY: "bytag_different_passkey",
  INCONCLUSIVE: "bytag_inconclusive",
} as const
