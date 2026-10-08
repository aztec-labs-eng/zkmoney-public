import type { IStorageAdapter, StorageLock } from "./adapter.js"
import { REQUEST_STORAGE_KEY } from "./storage-constants.js"

export type RequestDirection = "outgoing" | "incoming"

export type RequestStatus = "pending" | "cancelled" | "declined" | "fulfilled"

/**
 * How the request was created: `"contact"` (announced to a saved contact over
 * XMTP) or `"link"` (a shareable `…/request#<fragment>` link). Older rows
 * predate the field and migrate-on-read to `"contact"`.
 */
export type RequestKind = "contact" | "link"

export interface PaymentRequest {
  id: string
  /** Bare tag (no leading `@`, no `.zk.money`). Matches ContactStorage. */
  contactTag: string
  /** USD amount as a number. */
  amount: number
  /** Asset symbol — the wallet is single-asset, so always the current ticker. */
  asset: string
  direction: RequestDirection
  status: RequestStatus
  /** ms since epoch. */
  createdAt: number
  /** Optional free-form note. */
  note?: string
  /** Contact request vs shareable link. Defaults to `"contact"` on read. */
  kind?: RequestKind
  /** Token contract address (hex) — carried on requests delivered over XMTP. */
  tokenAddress?: string
  /** Raw amount in the token's base units (stringified). `"0"` = "any amount". */
  amountAtomic?: string
  /** Decimal exponent `amountAtomic` was scaled by — keeps a re-shared link
   * self-describing even after the ambient per-network decimals change. */
  tokenDecimals?: number
  /** Optional soft expiry (epoch ms). */
  expiresAt?: number
  /** Hash of the L2 send that fulfilled this request. */
  fulfillmentTxHash?: string
  /** Aztec network the request targets. */
  networkId?: string
  /** Requester's tag at mint time — preferred over the current tag when re-minting a share URL. */
  requesterTag?: string
  /** Requester's L2 address at mint time. */
  requesterAddress?: string
  /** Self-broadcast L1 SIPA at mint time — rebuilt into the share URL. */
  sipaAddress?: string
}

interface StoredShape {
  requests: PaymentRequest[]
}

// Status transition ranks used by the monotonic guard. `fulfilled` always wins
// (a real on-chain payment is authoritative) and only `reopen` undoes it, when
// the network reverts that payment; `declined` / `cancelled` are only reachable
// from `pending`.
function canApply(current: RequestStatus, next: RequestStatus): boolean {
  if (current === next) return false
  if (next === "fulfilled") return current !== "fulfilled"
  return current === "pending"
}

/**
 * `IStorageAdapter`-backed store for P2P payment requests, with a monotonic
 * status guard. Change listeners fire after every successful
 * write so request lists react without polling.
 */
export class RequestStorage {
  private static instance: RequestStorage | null = null

  /** Same singleton convention as the sibling stores: the first call supplies the adapter. */
  static get(storage?: IStorageAdapter, lock?: StorageLock): RequestStorage {
    if (!RequestStorage.instance) {
      if (!storage) {
        throw new Error("First call to get requires a storage adapter")
      }
      RequestStorage.instance = new RequestStorage(storage, lock)
    }
    return RequestStorage.instance
  }

  /** Test seam — drops the singleton. Production code never calls this. */
  static resetForTests(): void {
    RequestStorage.instance = null
  }

  private listeners = new Set<() => void>()

  constructor(
    private storage: IStorageAdapter,
    /** Cross-context write mutex (web: navigator.locks). Absent = writes run directly. */
    private lock?: StorageLock,
  ) {}

  /**
   * Every read-modify-write runs through here. With a lock, the read inside `fn` happens in the
   * critical section, so two contexts' cycles can't interleave and drop rows.
   */
  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    return this.lock ? this.lock(fn) : fn()
  }

  private async read(): Promise<PaymentRequest[]> {
    const raw = await this.storage.getItem(REQUEST_STORAGE_KEY)
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw) as StoredShape
      if (!Array.isArray(parsed.requests)) return []
      // Migrate-on-read: rows written before `kind` existed are contact requests.
      return parsed.requests.map((r) => ({ ...r, kind: r.kind ?? "contact" }))
    } catch {
      return []
    }
  }

  private async write(requests: PaymentRequest[]): Promise<void> {
    await this.storage.setItem(
      REQUEST_STORAGE_KEY,
      JSON.stringify({ requests } satisfies StoredShape),
    )
    for (const listener of this.listeners) listener()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async list(): Promise<PaymentRequest[]> {
    return this.read()
  }

  async listForContact(contactTag: string): Promise<PaymentRequest[]> {
    const all = await this.read()
    const tag = contactTag.toLowerCase()
    return all.filter((r) => r.contactTag.toLowerCase() === tag)
  }

  async add(request: PaymentRequest): Promise<void> {
    await this.mutate(async () => {
      const all = await this.read()
      all.push(request)
      await this.write(all)
    })
  }

  /**
   * Insert a request only if no row with the same `id` exists. `inserted:false`
   * means a row is already present (dedup on the `requestId` join key), so a
   * re-delivered incoming request is a no-op.
   */
  async addIfAbsent(request: PaymentRequest): Promise<{ inserted: boolean }> {
    return this.mutate(async () => {
      const all = await this.read()
      if (all.some((r) => r.id === request.id)) return { inserted: false }
      all.push(request)
      await this.write(all)
      return { inserted: true }
    })
  }

  async findById(id: string): Promise<PaymentRequest | null> {
    const all = await this.read()
    return all.find((r) => r.id === id) ?? null
  }

  /**
   * Apply a status transition under the monotonic guard. `applied:false` when
   * there is no matching row or the transition is disallowed (e.g. already
   * fulfilled). Idempotent — re-applying the same status is a no-op.
   */
  async applyStatus(
    id: string,
    status: RequestStatus,
    txHash?: string,
  ): Promise<{ applied: boolean }> {
    return this.mutate(async () => {
      const all = await this.read()
      const idx = all.findIndex((r) => r.id === id)
      if (idx < 0) return { applied: false }
      if (!canApply(all[idx].status, status)) return { applied: false }
      all[idx] = { ...all[idx], status, ...(txHash ? { fulfillmentTxHash: txHash } : {}) }
      await this.write(all)
      return { applied: true }
    })
  }

  /**
   * Back to pending: the network reverted the payment that fulfilled this request. Only that
   * payment's hash reopens it, so an unrelated reverted receive never touches a paid request.
   */
  async reopen(id: string, txHash: string): Promise<{ applied: boolean }> {
    return this.mutate(async () => {
      const all = await this.read()
      const idx = all.findIndex((r) => r.id === id)
      if (idx < 0) return { applied: false }
      const { fulfillmentTxHash, ...row } = all[idx]
      if (row.status !== "fulfilled" || fulfillmentTxHash?.toLowerCase() !== txHash.toLowerCase()) {
        return { applied: false }
      }
      all[idx] = { ...row, status: "pending" }
      await this.write(all)
      return { applied: true }
    })
  }

  async remove(id: string): Promise<void> {
    await this.mutate(async () => {
      const all = await this.read()
      await this.write(all.filter((r) => r.id !== id))
    })
  }
}
