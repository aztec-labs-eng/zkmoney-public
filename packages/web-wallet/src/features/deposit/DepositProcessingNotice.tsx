/**
 * Why a funded deposit is still waiting, beside its status in the deposit sheets. The row and the notification say the
 * same headline. "Check again" re-reads the deposit's own portal; it never sweeps or recovers anything.
 */
import { useState, type ReactNode } from "react"
import type { SipaProcessingState } from "@obsidion/front-core"
import { whenLabel } from "../../ui/detailRows"
import { processingCopy } from "./processingCopy"
import { sipaProcessingObserver } from "./sipaProcessing"

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
  if (state.reason.kind === "processing" && !state.blocker) return null

  const copy = processingCopy(state, symbol)
  const checkAgain = async () => {
    setChecking(true)
    try {
      await sipaProcessingObserver()?.retry(sipaAddress)
    } finally {
      setChecking(false)
    }
  }
  const detail = copy.lines.map((line) => (
    <p key={line} className="ww-about-limits__note">
      {line}
    </p>
  ))
  return (
    <div className="ww-pending-reason" role="status" data-testid="deposit-pending-reason">
      <span className="ww-pending-reason__head">
        <b>{copy.headline}</b>
        {help && <span data-testid="deposit-pending-reason-help">{help(detail)}</span>}
      </span>
      {copy.funds && <p>{copy.funds}</p>}
      {!help && (
        <>
          {detail}
          {/* The details show their own read time. */}
          {copy.checkedAt !== undefined && <small>Last checked {whenLabel(copy.checkedAt)}</small>}
        </>
      )}
      {copy.canCheckAgain && (
        <button
          type="button"
          className="zkm-btn-reset ww-deposit__link"
          disabled={checking}
          onClick={() => void checkAgain()}
        >
          {checking ? "Checking…" : "Check again"}
        </button>
      )}
    </div>
  )
}
