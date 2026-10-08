import type { ReactNode } from "react"
import { Icon } from "@obsidion/web-ds"
import { InfoButton } from "../limits/InfoButton"
import { CAPACITY_CHECKING, type FundingCapacityView } from "./fundingCapacity"

const TONE_ICON: Record<FundingCapacityView["tone"], string | undefined> = {
  ok: "check-circle",
  warn: "alert-triangle",
  blocked: "alert-circle",
  checking: undefined,
}

/**
 * Shared deposit capacity next to an amount or address. Healthy capacity, and unknown capacity that does not
 * hold funding, add nothing; any other state is one short line with its actions. The figure, check time and rules
 * are in the About limits sheet. The status stays mounted, so a change is announced.
 */
export function FundingCapacityPanel({
  view,
  onRetry,
  onUseAvailable,
  onAboutLimits,
  detail,
}: {
  view: FundingCapacityView
  onRetry: () => void
  /** Editable amounts only; sets the amount to `view.availableAmount` when the user asks. */
  onUseAvailable?: (amount: string) => void
  /** Opens the About limits sheet on capacity. */
  onAboutLimits?: () => void
  /** A route's own short line that affects the action, such as the most that fits now. */
  detail?: ReactNode
}) {
  // A fit is not a promise: a low fit only says capacity is low.
  const status =
    view.tone === "checking" ? CAPACITY_CHECKING : view.canFund ? view.detailText : view.statusText
  const shown = (view.tone !== "ok" && !!status) || !!detail
  const icon = TONE_ICON[view.tone]
  const useAvailable = view.availableAmount && onUseAvailable
  return (
    <section
      className={`ww-capacity ww-capacity--${view.tone}${shown ? "" : " ww-capacity--quiet"}`}
      aria-label="Network capacity"
      data-testid="funding-capacity-panel"
      data-tone={view.tone}
    >
      <div className="ww-capacity__line">
        <p className="ww-capacity__status" role="status" data-testid="funding-capacity-status">
          {shown && view.tone !== "ok" && status && (
            <>
              {icon && <Icon name={icon} size={14} />}
              <span>{status}</span>
            </>
          )}
        </p>
        {shown && onAboutLimits && (
          <InfoButton label="About network capacity" onClick={onAboutLimits} />
        )}
      </div>
      {shown && (
        <>
          {!view.canFund && view.detailText && <p className="ww-limits__note">{view.detailText}</p>}
          {detail}
          {(view.offerRetry || useAvailable) && (
            <div className="ww-capacity__actions">
              {view.offerRetry && (
                <button
                  type="button"
                  className="zkm-btn-reset ww-deposit__link"
                  onClick={onRetry}
                  data-testid="funding-capacity-retry"
                >
                  Check again
                </button>
              )}
              {useAvailable && (
                <button
                  type="button"
                  className="zkm-btn-reset ww-deposit__link"
                  onClick={() => onUseAvailable(view.availableAmount!)}
                  data-testid="funding-capacity-use-available"
                >
                  Use available amount
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
