import { useCallback } from "react"
import { useStore } from "@obsidion/front-core"
import type { WithdrawalRecord } from "@obsidion/front-core"
import { useSession } from "../../session/session"

export interface WithdrawalsState {
  records: readonly WithdrawalRecord[]
  /** True once the last-known records were read back from storage. */
  hydrated: boolean
  /** Post-mine "Check again": a tracker pass now. */
  checkAgain: (l2TxHash: string) => Promise<void>
}

/** Live view over the persisted withdrawal records. The session runs the tracker. */
export function useWithdrawals(): WithdrawalsState {
  const session = useSession()
  const { records, hydrated } = useStore(session.withdrawals.list)

  const checkAgain = useCallback(() => session.wake(session.tasks.withdrawalTracker), [session])

  return { records, hydrated, checkAgain }
}
