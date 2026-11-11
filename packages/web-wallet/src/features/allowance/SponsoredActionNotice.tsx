import { sponsoredActionBlock } from "./allowanceView"
import { useSponsoredAllowance } from "./useSponsoredAllowance"

/**
 * Why the sponsored action on this sheet cannot be sent, or undefined. The allowance is read again
 * when the sheet enables it, since the last batch may have spent a use.
 */
export function useSponsoredActionBlock(enabled: boolean): string | undefined {
  const { snapshot } = useSponsoredAllowance(enabled)
  return enabled ? sponsoredActionBlock(snapshot) : undefined
}

/** The reason beside the disabled action. */
export function SponsoredActionNotice({ reason }: { reason: string | undefined }) {
  if (!reason) return null
  return (
    <p className="ww-allowance-notice" data-testid="sponsored-action-blocked">
      <span aria-hidden="true">⚠ </span>
      {reason}
    </p>
  )
}
