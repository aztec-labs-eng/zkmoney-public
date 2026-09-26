import { Icon } from "@obsidion/web-ds"
import { useState } from "react"
import { useLeavingLosesTransaction } from "../features/operations/operations"
import "./bakedProfileNotice.css"

export interface BakedProfileNoticeProps {
  /** The snapshot's `publishedAt`. */
  publishedAt: string
  reload?: () => void
}

/**
 * Shown while the wallet runs on the profile baked into this build because the config service
 * could not be reached. Dismissible: the strip sits above every sheet and drawer (the app shell is
 * its own stacking context), so a phone user must be able to clear it to reach a sheet's action.
 */
export function BakedProfileNotice({
  publishedAt,
  reload = () => window.location.reload(),
}: BakedProfileNoticeProps) {
  const [dismissed, setDismissed] = useState(false)
  // A reload would end a running proof.
  const losesTransaction = useLeavingLosesTransaction()
  if (dismissed) return null
  const date = new Date(publishedAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
  return (
    <div className="ww-baked-notice" role="status">
      <Icon name="alert-circle" size={18} color="var(--accent-gold)" />
      <span className="ww-baked-notice__text">
        zk.money's configuration service could not be reached, so this wallet is running on the
        configuration it shipped with (published {date}). That configuration may be outdated and
        some actions may fail — reload to try again before transacting.
      </span>
      <button
        type="button"
        className="zkm-btn-reset ww-baked-notice__action"
        onClick={reload}
        disabled={losesTransaction}
      >
        Reload
      </button>
      <button
        type="button"
        className="zkm-btn-reset ww-baked-notice__dismiss"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
      >
        <Icon name="x" size={14} strokeWidth={2.5} />
      </button>
    </div>
  )
}
