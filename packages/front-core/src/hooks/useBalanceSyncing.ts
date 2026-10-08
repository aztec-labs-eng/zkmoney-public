import { useEffect, useState } from "react"
import { bootPriority } from "../core/services/transactions/bootPriority"

type BalanceSync = { syncing: boolean; progress: number | null }

const read = (): BalanceSync => ({
  syncing: bootPriority.isBalanceSyncing(),
  progress: bootPriority.balanceSyncProgress(),
})

/**
 * Whether a fresh device's first balance may still be short of replayed deposits, and how much of
 * the replay is done (null until its total is known).
 */
export function useBalanceSyncing(): BalanceSync {
  const [state, setState] = useState(read)
  useEffect(() => {
    setState(read())
    return bootPriority.onChange(() => setState(read()))
  }, [])
  return state
}
