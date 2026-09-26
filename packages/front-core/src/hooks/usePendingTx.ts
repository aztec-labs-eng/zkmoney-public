/**
 * `usePendingTx` — React hook subscribing to a single `IPendingTxStore`
 * record by `txHash`. Mirrors the `useTransactions` pattern: maintains local
 * state, re-reads on `onUpdated`, returns the current record + a manual
 * refresh trigger.
 *
 * The store is passed in by the caller (the wallet's injected
 * `IPendingTxStore`) — front-core does not own a context for it yet. When
 * the lifecycle service eventually lands a context provider, this hook
 * stays forward-compatible (pass `undefined` to disable).
 */

import { useCallback, useEffect, useState } from "react"
import type { IPendingTxStore, PendingTxRecord } from "@obsidion/sdk"

/**
 * Subscribe to a single record by `txHash`. Re-reads on every `onUpdated`
 * tick that mentions the watched hash. Returns `null` until the first read
 * completes, `undefined` if the record is absent or expired, and a record
 * object otherwise.
 *
 * Pass `store === undefined` to disable — useful for code paths that may
 * or may not have a wallet-injected store available at render time.
 */
export function usePendingTx(
  store: IPendingTxStore | undefined,
  txHash: string | undefined,
): PendingTxRecord | undefined {
  const [record, setRecord] = useState<PendingTxRecord | undefined>(undefined)

  const refresh = useCallback(async () => {
    if (!store || !txHash) {
      setRecord(undefined)
      return
    }
    const next = await store.get(txHash)
    setRecord(next)
  }, [store, txHash])

  useEffect(() => {
    let cancelled = false
    if (!store || !txHash) {
      setRecord(undefined)
      return
    }

    // Initial read.
    void store.get(txHash).then((r) => {
      if (!cancelled) setRecord(r)
    })

    const lowered = txHash.toLowerCase()
    const unsubscribe = store.onUpdated((changedHash) => {
      if (changedHash.toLowerCase() !== lowered) return
      void store.get(txHash).then((r) => {
        if (!cancelled) setRecord(r)
      })
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [store, txHash])

  // `refresh` deliberately unused outside the effect — kept on the closure
  // for parity with `useTransactions` and future opt-in (e.g. pull-to-refresh).
  void refresh

  return record
}

/**
 * Subscribe to the full non-expired list. Useful for activity-screen rows
 * that want to badge "pending" status. Re-reads on any `onUpdated` tick.
 */
export function usePendingTxList(
  store: IPendingTxStore | undefined,
): readonly PendingTxRecord[] {
  const [records, setRecords] = useState<readonly PendingTxRecord[]>([])

  useEffect(() => {
    let cancelled = false
    if (!store) {
      setRecords([])
      return
    }

    const reload = async () => {
      const next = await store.list()
      if (!cancelled) setRecords(next)
    }

    void reload()

    const unsubscribe = store.onUpdated(() => {
      void reload()
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [store])

  return records
}
