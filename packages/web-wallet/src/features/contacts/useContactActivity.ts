import { useEffect, useState } from "react"
import {
  RequestStorage,
  TransactionStorage,
  globalEventEmitter,
  type ContactActivitySources,
} from "@obsidion/front-core"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { getSipaDepositGateway } from "../deposit/sipaGateway"
import { getWithdrawalStore } from "../withdraw/withdrawGateway"

/** Compose the account-scoped web sources without polling or starting network activity. */
export function useContactActivity(enabled: boolean): ContactActivitySources {
  const [sources, setSources] = useState<ContactActivitySources>({})
  useEffect(() => {
    if (!enabled) return
    let active = true
    let revision = 0
    const requests = RequestStorage.get()
    const deposits = getSipaDepositGateway()
    const withdrawals = getWithdrawalStore()
    const rebuild = async () => {
      const current = ++revision
      const [transactions, requestRows] = await Promise.all([
        TransactionStorage.get(webStorage)
          .getTransactions()
          .catch(() => []),
        requests.list().catch(() => []),
        withdrawals.load().catch(() => {}),
      ])
      if (!active || current !== revision) return
      setSources({
        transactions,
        requests: requestRows,
        sipaDeposits: deposits.records(),
        withdrawals: withdrawals.list(),
      })
    }
    const update = () => {
      void rebuild()
    }
    globalEventEmitter.onTransactionsUpdated(update)
    const offRequests = requests.subscribe(update)
    const offDeposits = deposits.subscribe(update)
    const offWithdrawals = withdrawals.onListChanged(update)
    update()
    return () => {
      active = false
      globalEventEmitter.offTransactionsUpdated(update)
      offRequests()
      offDeposits()
      offWithdrawals()
    }
  }, [enabled])
  return sources
}
