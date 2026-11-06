import type { Database, Write } from "./database"
import { WalletError } from "./errors"
import { encodeRecord, persistentStore } from "./persistentStore"

/**
 * The L1 NameClaim artifacts ClaimFPC's NameClaim gate verifies, for one L2 account. The Registry
 * emits the same values in its `NameClaimed` event, so a confirmed claim is rebuilt from L1; only a
 * pending claim's signed terms cannot be.
 */
export interface NameClaimRecord {
  /** L2 account the claim is bound to; the record key. */
  address: string
  /** Display tag. */
  handle: string
  /** Registry node the domain owner signed. Absent on entries cached before recovery existed. */
  nameHash?: string
  /** Domain-owner secp256k1 signature over the EIP-712 NameClaim. */
  signature: string
  nonce: string
  deadline: string
  /** Operator-signed registration terms beside the claim, for the manual sweep. Absent when the
   *  claim server issued none: the contract's immutable schedule applies. */
  terms?: {
    fee: string
    minDeposit: string
    nonce: string
    deadline: string
    signature: string
  }
}

/**
 * The account's name claims, one per L2 account. Entries are never dropped on a successful
 * subscribe: the subscription nullifier is siloed by ClaimFPC's address, so a redeployed FPC
 * subscribes again with the same artifacts.
 */
export interface NameClaims {
  readonly ready: Promise<void>
  get(address: string): Promise<NameClaimRecord | undefined>
  put(record: NameClaimRecord, w?: Write): Promise<void>
}

/** The blob older builds kept in the account's namespace, keyed by lowercase L2 address. */
export const LEGACY_NAME_CLAIMS_KEY = "obsidion_name_claims"

const claimId = (address: string) => address.toLowerCase()

/**
 * Version 1 carries the older build's pending claims, the entries with signed terms; the detection
 * rebuilds a confirmed claim from the log. A blob that cannot be read fails the open and keeps its
 * bytes, since a pending claim's terms exist nowhere else.
 */
export function createNameClaims({ db }: { db: Database }): NameClaims {
  const store = persistentStore<NameClaimRecord>(db, {
    prefix: "acct/nameClaims",
    version: 1,
    id: (record) => claimId(record.address),
    load: "all",
    async migrate(from, w) {
      if (from !== undefined)
        throw new WalletError("invariant", `nameClaims: unknown version ${from}`)
      for (const record of pendingClaims(await w.get(LEGACY_NAME_CLAIMS_KEY)))
        w.put(`acct/nameClaims/${claimId(record.address)}`, encodeRecord(record))
    },
  })
  return {
    ready: store.ready,
    get: (address) => store.get(claimId(address)),
    put: (record, w) => store.put(record, w),
  }
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
