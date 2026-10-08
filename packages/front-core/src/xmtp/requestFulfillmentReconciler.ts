/**
 * Flips pending outgoing payment-request rows to `fulfilled` when a verified incoming transfer
 * carrying the row's id in its on-chain `Transfer.meta` lands. Covers both event orderings:
 *
 * 1. `incomingTransfer` joins a new receive against already stored requests.
 * 2. A start-time and request-store-change sweep joins pending rows against already stored receives.
 *
 * A contact request additionally requires the verified sender attribution to be that contact; a
 * link row (`contactTag: ""`) accepts any payer. A receive the network reverted pays nothing, and
 * a request it had already paid reopens. All paths are idempotent (`applyStatus` / `reopen` guard).
 */

import { globalEventEmitter } from "../core/services/GlobalEventEmitter.js"
import type { RequestStorage } from "../core/storages/RequestStorage.js"
import type { TokenTransaction } from "../types/transactions.js"

import { fulfillmentSatisfiesRequest } from "./RequestReceiver.js"

type RequestStore = Pick<RequestStorage, "list" | "applyStatus"> &
  Partial<Pick<RequestStorage, "subscribe" | "reopen">>

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
  if (!requestId || !tx.txHash || tx.status === "failed") return
  const all = await store.list()
  for (const row of all) {
    if (row.direction !== "outgoing" || row.status !== "pending") continue
    if (row.id.toLowerCase() !== requestId) continue
    if (row.contactTag && row.contactTag.toLowerCase() !== (tx.from ?? "").toLowerCase()) continue
    if (!fulfillmentSatisfiesRequest(row, tx)) continue
    await store.applyStatus(row.id, "fulfilled", tx.txHash)
  }
}

/**
 * Reverse join: reopen each paid outgoing row whose paying receive the network reverted, then look
 * for an already-stored fulfilling receive for each pending one.
 */
async function sweepRequests(store: RequestStore, receives: ReceivesByRequestId): Promise<void> {
  const outgoing = (await store.list()).filter((row) => row.direction === "outgoing")
  const pending = outgoing.filter((row) => row.status === "pending")
  const paid = store.reopen
    ? outgoing.filter((row) => row.status === "fulfilled" && !!row.fulfillmentTxHash)
    : []
  if (pending.length === 0 && paid.length === 0) return

  const batched = await receives.findReceivesByRequestIds?.(
    [...pending, ...paid].map((row) => row.id),
  )
  const receivesFor = async (id: string) =>
    batched?.get(id.toLowerCase()) ?? (batched ? [] : await receives.findReceivesByRequestId(id))

  for (const row of paid) {
    const hash = row.fulfillmentTxHash!.toLowerCase()
    const payment = (await receivesFor(row.id)).find((tx) => tx.txHash?.toLowerCase() === hash)
    // The store change it writes runs the sweep again, which may pay the row from another receive.
    if (payment?.status === "failed") await store.reopen!(row.id, hash)
  }

  for (const row of pending) {
    const candidates = await receivesFor(row.id)
    for (const tx of candidates) {
      if (!tx.txHash || tx.status === "failed") continue
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
      void sweepRequests(store, receives)
        .catch((err) => console.warn("[requestFulfillmentReconciler] sweep failed:", err))
        .finally(() => {
          sweeping = false
          if (dirty) {
            dirty = false
            sweep()
          }
        })
    }
    // Listening first: a reopen the first sweep writes must trigger the sweep that re-pays it.
    unsubscribeStore = store.subscribe?.(sweep)
    sweep()
    // A receive the network re-confirms fires no incoming transfer; its row write does.
    globalEventEmitter.onTransactionsUpdated(sweep)
    const offStore = unsubscribeStore
    unsubscribeStore = () => {
      offStore?.()
      globalEventEmitter.offTransactionsUpdated(sweep)
    }
  }

  return () => {
    globalEventEmitter.offIncomingTransfer(onTransfer)
    unsubscribeStore?.()
  }
}
