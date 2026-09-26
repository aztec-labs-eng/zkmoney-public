/**
 * Flips pending outgoing payment-request rows to `fulfilled` when a verified incoming transfer
 * carrying the row's id in its on-chain `Transfer.meta` lands. Covers both event orderings:
 *
 * 1. `incomingTransfer` joins a new receive against already stored requests.
 * 2. A start-time and request-store-change sweep joins pending rows against already stored receives.
 *
 * A contact request additionally requires the verified sender attribution to be that contact; a
 * link row (`contactTag: ""`) accepts any payer. All paths are idempotent (`applyStatus` guards).
 */

import { globalEventEmitter } from "../core/services/GlobalEventEmitter.js"
import type { RequestStorage } from "../core/storages/RequestStorage.js"
import type { TokenTransaction } from "../types/transactions.js"

import { fulfillmentSatisfiesRequest } from "./RequestReceiver.js"

type RequestStore = Pick<RequestStorage, "list" | "applyStatus"> &
  Partial<Pick<RequestStorage, "subscribe">>

/** Receives lookup for the reverse join. */
export type ReceivesByRequestId = {
  findReceivesByRequestId(requestId: string): Promise<TokenTransaction[]>
  /** Batched form; the sweep prefers it so one pass over the history serves every pending row. */
  findReceivesByRequestIds?(requestIds: readonly string[]): Promise<Map<string, TokenTransaction[]>>
}

export async function reconcileRequestFulfillments(
  store: RequestStore,
  tx: TokenTransaction,
): Promise<void> {
  const requestId = tx.requestId?.toLowerCase()
  if (!requestId || !tx.txHash) return
  const all = await store.list()
  for (const row of all) {
    if (row.direction !== "outgoing" || row.status !== "pending") continue
    if (row.id.toLowerCase() !== requestId) continue
    if (row.contactTag && row.contactTag.toLowerCase() !== (tx.from ?? "").toLowerCase()) continue
    if (!fulfillmentSatisfiesRequest(row, tx)) continue
    await store.applyStatus(row.id, "fulfilled", tx.txHash)
  }
}

/** Reverse join: for each pending outgoing row, look for an already-stored fulfilling receive. */
async function sweepPendingRequests(
  store: RequestStore,
  receives: ReceivesByRequestId,
): Promise<void> {
  const all = await store.list()
  const pending = all.filter((row) => row.direction === "outgoing" && row.status === "pending")
  if (pending.length === 0) return

  const batched = await receives.findReceivesByRequestIds?.(pending.map((row) => row.id))
  for (const row of pending) {
    const candidates =
      batched?.get(row.id.toLowerCase()) ??
      (batched ? [] : await receives.findReceivesByRequestId(row.id))
    for (const tx of candidates) {
      if (!tx.txHash) continue
      if (row.contactTag && row.contactTag.toLowerCase() !== (tx.from ?? "").toLowerCase()) continue
      if (!fulfillmentSatisfiesRequest(row, tx)) continue
      await store.applyStatus(row.id, "fulfilled", tx.txHash)
      break
    }
  }
}

/**
 * Subscribe; returns the unsubscribe. When `receives` is supplied, a sweep runs at start and on
 * every request-store change, so a request row that lands after its receive still flips.
 */
export function startRequestFulfillmentReconciler(
  store: RequestStore,
  receives?: ReceivesByRequestId,
): () => void {
  const onTransfer = (tx: TokenTransaction): void => {
    void reconcileRequestFulfillments(store, tx).catch((err) =>
      console.warn("[requestFulfillmentReconciler] reconcile failed:", err),
    )
  }
  globalEventEmitter.onIncomingTransfer(onTransfer)

  let unsubscribeStore: (() => void) | undefined
  if (receives) {
    let sweeping = false
    let dirty = false
    const sweep = (): void => {
      if (sweeping) {
        dirty = true
        return
      }
      sweeping = true
      void sweepPendingRequests(store, receives)
        .catch((err) => console.warn("[requestFulfillmentReconciler] sweep failed:", err))
        .finally(() => {
          sweeping = false
          if (dirty) {
            dirty = false
            sweep()
          }
        })
    }
    sweep()
    unsubscribeStore = store.subscribe?.(sweep)
  }

  return () => {
    globalEventEmitter.offIncomingTransfer(onTransfer)
    unsubscribeStore?.()
  }
}
