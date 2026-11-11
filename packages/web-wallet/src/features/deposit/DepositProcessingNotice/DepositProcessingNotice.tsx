/**
 * Why a funded deposit is still waiting, beside its status in the deposit sheets. The row and the notification say the
 * same headline. "Check again" re-reads the deposit's own portal; it never sweeps or recovers anything.
 */
import { useState, type ReactNode } from "react"
import type { SipaProcessingState } from "@obsidion/front-core"
import { whenLabel } from "../../../ui/detailRows"
import { processingCopy } from "../processingCopy"
import { useSession } from "../../../session/session"
import { fmt } from "../../../lib/fmt"
import copy from "./DepositProcessingNotice.copy"
import styles from "./DepositProcessingNotice.module.css"

export function DepositProcessingNotice({
  sipaAddress,
  state,
  symbol,
  help,
}: {
  sipaAddress: string
  state: SipaProcessingState
  /** The settlement token capacity is counted in. */
  symbol: string
  /** The info button beside the headline, given the explanation to show in its details. Without one, the
   *  explanation is shown here. */
  help?: (detail: ReactNode) => ReactNode
}) {
  const [checking, setChecking] = useState(false)
  const session = useSession()
  if (state.reason.kind === "processing" && !state.blocker) return null

  const notice = processingCopy(state, symbol)
  const checkAgain = async () => {
    setChecking(true)
    try {
      await session.sipaProcessingObserver?.retry(sipaAddress)
    } finally {
      setChecking(false)
    }
  }
  const detail = notice.lines.map((line) => (
    <p key={line} className="ww-about-limits__note">
      {line}
    </p>
  ))
  return (
    <div className={styles.notice} role="status" data-testid="deposit-pending-reason">
      <span className={styles.head}>
        <b>{notice.headline}</b>
        {help && <span data-testid="deposit-pending-reason-help">{help(detail)}</span>}
      </span>
      {notice.funds && <p>{notice.funds}</p>}
      {!help && (
        <>
          {detail}
          {/* The details show their own read time. */}
          {notice.checkedAt !== undefined && (
            <small>{fmt(copy.lastChecked, { when: whenLabel(notice.checkedAt) })}</small>
          )}
        </>
      )}
      {notice.canCheckAgain && (
        <button
          type="button"
          className="zkm-btn-reset ww-deposit__link"
          disabled={checking}
          onClick={() => void checkAgain()}
        >
          {checking ? copy.checking : copy.checkAgain}
        </button>
      )}
    </div>
  )
}
