/**
 * Storage migration: the pending name claims older builds kept. Remove when no supported build
 * older than the one that writes `acct/nameClaims` v1 remains.
 */
import type { Write } from "../engine/database"
import { WalletError } from "../engine/errors"
import type { NameClaimRecord } from "../engine/nameClaims"
import { encodeRecord } from "../engine/persistentStore"

/** The blob older builds kept in the account's namespace, keyed by lowercase L2 address. */
export const LEGACY_NAME_CLAIMS_KEY = "obsidion_name_claims"

/**
 * Version 1 carries the older build's pending claims, the entries with signed terms; the detection
 * rebuilds a confirmed claim from the log. A blob that cannot be read fails the open and keeps its
 * bytes, since a pending claim's terms exist nowhere else.
 */
export async function migrateNameClaims(
  from: number | undefined,
  w: Write,
  { id }: { id: (address: string) => string },
): Promise<void> {
  if (from !== undefined) throw new WalletError("invariant", `nameClaims: unknown version ${from}`)
  for (const record of pendingClaims(await w.get(LEGACY_NAME_CLAIMS_KEY)))
    w.put(`acct/nameClaims/${id(record.address)}`, encodeRecord(record))
}

const unreadable = (detail: string) => new WalletError("unknown", `nameClaims: ${detail}`)

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const CLAIM_STRINGS = ["address", "handle", "signature", "nonce", "deadline"] as const
const TERMS_STRINGS = ["fee", "minDeposit", "nonce", "deadline", "signature"] as const

function pendingClaims(raw: string | undefined): NameClaimRecord[] {
  if (raw === undefined) return []
  let saved: unknown
  try {
    saved = JSON.parse(raw)
  } catch {
    throw unreadable("the saved claims do not parse")
  }
  if (!isObject(saved)) throw unreadable("the saved claims are not a claim map")
  return Object.values(saved).flatMap((value) => {
    if (!isObject(value) || !CLAIM_STRINGS.every((key) => typeof value[key] === "string"))
      throw unreadable("a saved claim is not one")
    if (value.terms === undefined) return []
    const terms = value.terms
    if (!isObject(terms) || !TERMS_STRINGS.every((key) => typeof terms[key] === "string"))
      throw unreadable(`the saved claim of ${String(value.address)} has unreadable terms`)
    return [value as unknown as NameClaimRecord]
  })
}
