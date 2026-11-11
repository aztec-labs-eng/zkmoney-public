import { useState } from "react"
import { PasskeysSheet } from "../../ui/PasskeysSheet/PasskeysSheet"
import { moveCopy } from "./backupPasskeyCopy"
import { useRotationDrives } from "./rotationDrive"
import { approvalWaiting } from "./useBackupNudge"

/** Home's line while a rotation's move waits for the user's tap; the tap itself is in Settings. */
export function RotationApprovalLine() {
  const waiting = approvalWaiting(useRotationDrives())
  const [sheet, setSheet] = useState(false)
  return (
    <>
      {waiting && (
        <div
          className="ww-banner ww-banner--static"
          data-testid="rotation-approval-line"
          aria-live="polite"
        >
          <span className="ww-banner__text">
            <span className="ww-banner__title">{moveCopy.home}</span>
            <span className="ww-banner__body">{moveCopy.homeDetail}</span>
          </span>
          <button
            type="button"
            className="zkm-btn-reset ww-deposit__link"
            onClick={() => setSheet(true)}
          >
            {moveCopy.resume}
          </button>
        </div>
      )}
      {sheet && <PasskeysSheet onClose={() => setSheet(false)} />}
    </>
  )
}
