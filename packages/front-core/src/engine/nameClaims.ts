import type { Database, Write } from "./database"
import { persistentStore } from "./persistentStore"
import { migrateNameClaims } from "../storageMigrations/nameClaims"

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

const claimId = (address: string) => address.toLowerCase()

export function createNameClaims({ db }: { db: Database }): NameClaims {
  const store = persistentStore<NameClaimRecord>(db, {
    prefix: "acct/nameClaims",
    version: 1,
    id: (record) => claimId(record.address),
    load: "all",
    migrate: (from, w) => migrateNameClaims(from, w, { id: claimId }),
  })
  return {
    ready: store.ready,
    get: (address) => store.get(claimId(address)),
    put: (record, w) => store.put(record, w),
  }
}
