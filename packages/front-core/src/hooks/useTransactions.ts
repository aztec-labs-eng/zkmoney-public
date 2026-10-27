import { useCallback, useEffect, useRef, useState } from "react"
import { TransactionStorage, TransactionTracker, globalEventEmitter } from "src/core"
import type { Transaction } from "src/types"

/**
 * Hook for transaction polling + real-time updates.
 * Extracts the duplicated pattern from HomeScreen and ActivityScreen.
 */
export function useTransactions(account: { getAddress: () => unknown } | null | undefined) {
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const isActive = useRef(true)

  const loadTransactions = useCallback(async () => {
    try {
      const txs = await TransactionStorage.get().getTransactions()
      setTransactions(txs)
    } catch {
      setTransactions([])
    }
  }, [])

  const refresh = useCallback(() => {
    loadTransactions()
  }, [loadTransactions])

  useEffect(() => {
    if (!account) return

    isActive.current = true
    loadTransactions()

    const refreshInterval = setInterval(() => {
      if (isActive.current) {
        loadTransactions()
      }
    }, 3000)

    const handleQueueUpdate = () => {
      if (isActive.current) loadTransactions()
    }
    const handleTransactionsUpdate = () => {
      if (isActive.current) loadTransactions()
    }

    const queueManager = TransactionTracker.getInstance()
    queueManager.on("queueUpdated", handleQueueUpdate)
    globalEventEmitter.onTransactionsUpdated(handleTransactionsUpdate)

    return () => {
      isActive.current = false
      clearInterval(refreshInterval)
      queueManager.off("queueUpdated", handleQueueUpdate)
      globalEventEmitter.offTransactionsUpdated(handleTransactionsUpdate)
    }
  }, [account, loadTransactions])

  return { transactions, refresh }
}
