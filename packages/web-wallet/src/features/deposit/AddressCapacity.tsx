import type { ReactNode } from "react"
import type { AddressShareDecision } from "@obsidion/front-core"
import { FundingCapacityPanel } from "./FundingCapacityPanel"
import type { FundingCapacityView } from "./fundingCapacity"

/** Said on every Copy and Show QR while capacity is zero or not confirmed. It is never hidden. */
export const CAPACITY_SHARE_WARNING: Record<"warn-zero" | "warn-unknown", string> = {
  "warn-zero":
    "No network capacity is available right now. A deposit sent to this address will wait for capacity before it is processed. The funds stay at the address while they wait.",
  "warn-unknown":
    "Network capacity for this address isn't confirmed. A deposit sent to it may wait for capacity before it is processed. The funds stay at the address while they wait.",
}

export const ADDRESS_RECHECK_NOTE =
  "Anyone with this address can still send to it, and the wallet can't stop that transfer. A saved address or QR code doesn't keep this capacity check, so check again before each transfer."

/** The warning to repeat on Copy and Show QR, if the share decision calls for one. */
export function capacityShareWarning(decision: AddressShareDecision): string | undefined {
  return decision === "warn-zero" || decision === "warn-unknown"
    ? CAPACITY_SHARE_WARNING[decision]
    : undefined
}

/** 1147's capacity panel for an address. Callers put the recheck note in the About limits details. */
export function AddressCapacityPanel({
  view,
  onRetry,
  detail,
  onAboutLimits,
}: {
  view: FundingCapacityView
  onRetry: () => void
  /** Route-specific line, such as the most that fits current capacity. */
  detail?: ReactNode
  /** Opens the About limits sheet for this address's bucket. */
  onAboutLimits?: () => void
}) {
  return (
    <FundingCapacityPanel
      view={view}
      onRetry={onRetry}
      onAboutLimits={onAboutLimits}
      detail={
        detail && (
          <p className="ww-limits__note" data-testid="address-capacity-detail">
            {detail}
          </p>
        )
      }
    />
  )
}
