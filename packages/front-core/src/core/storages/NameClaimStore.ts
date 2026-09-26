import { RecordStorage } from "../services/bridge/RecordStorage.js"
import { NAME_CLAIM_STORAGE_KEY } from "./storage-constants.js"
import type { IStorageAdapter } from "./adapter.js"

/**
 * NameClaimStore — the device's cache of L1 NameClaim artifacts, per L2 account.
 *
 * These artifacts are the eligibility witness ClaimFPC's NameClaim gate verifies. A
 * CACHE, not a ledger: the Registry emits the same values in its `NameClaimed` event, so a client
 * holding the master key can always rebuild them from L1 (`readNameClaimLog`). Losing this store
 * costs one log query, never the account's sponsored fees.
 *
 * Entries are never dropped on a successful subscribe. The subscription nullifier is siloed by
 * ClaimFPC's contract address, so a redeployed FPC is a fresh nullifier space and the very same
 * artifacts subscribe again — discarding them is what turns a routine redeploy into an
 * unrecoverable state.
 *
 * Keyed by L2 account address, so a device that holds several accounts keeps a witness for each.
 */
export interface NameClaimRecord {
  /** L2 account the claim is bound to; the record key. */
  address: string
  /** Display tag. Not needed to build the witness — `nameHash` carries the signed identity. */
  handle: string
  /** Registry node the domain owner signed. Absent on entries cached before recovery existed. */
  nameHash?: string
  /** Domain-owner secp256k1 signature over the EIP-712 NameClaim. */
  signature: string
  nonce: string
  deadline: string
  /** Operator-signed registration terms cached beside the claim, for the manual sweep. Absent when
   *  the claim server issued none — the contract's immutable schedule applies. */
  terms?: {
    fee: string
    minDeposit: string
    nonce: string
    deadline: string
    signature: string
  }
}

export class NameClaimStore {
  private static instance: NameClaimStore | null = null
  private readonly store: RecordStorage<NameClaimRecord>

  private constructor(storage: IStorageAdapter) {
    this.store = new RecordStorage<NameClaimRecord>({
      storage,
      storageKey: NAME_CLAIM_STORAGE_KEY,
      keyOf: (record) => record.address.toLowerCase(),
      label: "NameClaimStore",
    })
  }

  static get(storage?: IStorageAdapter): NameClaimStore {
    if (!NameClaimStore.instance) {
      if (!storage) throw new Error("First call to NameClaimStore.get requires a storage adapter")
      NameClaimStore.instance = new NameClaimStore(storage)
    }
    return NameClaimStore.instance
  }

  /** Test seam — drops the singleton. Production code never calls this. */
  static resetForTests(): void {
    NameClaimStore.instance = null
  }

  async get(address: string): Promise<NameClaimRecord | null> {
    await this.store.load()
    return this.store.getByKey(address.toLowerCase())
  }

  async put(record: NameClaimRecord): Promise<void> {
    await this.store.load()
    await this.store.setRecord(record.address.toLowerCase(), record)
  }

  async remove(address: string): Promise<void> {
    await this.store.load()
    await this.store.removeByKey(address.toLowerCase())
  }
}
