import { useCallback, useEffect } from "react"
import { useAztecContext, useCachedRecords } from "@obsidion/front-core"
import type { WithdrawalRecord } from "@obsidion/front-core"
import { ensureWithdrawalTracker, getWithdrawalStore } from "./withdrawGateway"
import { reportWithdrawFunnel } from "./withdrawFunnel"
import { reportPaylinkClaims } from "../paylink/paylinkClaimReport"
import { webStorage } from "../../platform/storage/WebStorageAdapter"

export interface WithdrawalsState {
  records: WithdrawalRecord[]
  /** True once the last-known records were read back from storage. */
  hydrated: boolean
  /** Post-mine "Check again": kick an immediate re-poll for one record. */
  checkAgain: (l2TxHash: string) => Promise<void>
}

/** Live view over the persisted withdrawal records. `OperationsMount` runs the tracker. */
export function useWithdrawals(): WithdrawalsState {
  const { obsidionWallet } = useAztecContext()
  const store = getWithdrawalStore()
  const { records, hydrated } = useCachedRecords(store)

  // Gated on `hydrated`: the pre-hydration empty list would prune the persisted reported-phase
  // map and re-report every finalization. An L1 leg that completed while no tab was open is
  // reported from the record's own timestamps.
  useEffect(() => {
    if (!hydrated) return
    reportWithdrawFunnel(records, webStorage)
    void reportPaylinkClaims(records, webStorage)
  }, [records, hydrated])
  const checkAgain = useCallback(
    async (l2TxHash: string) => {
      if (!obsidionWallet) return
      const tracker = await ensureWithdrawalTracker(obsidionWallet)
      await tracker?.retry(l2TxHash)
    },
    [obsidionWallet],
  )

  return { records, hydrated, checkAgain }
}
