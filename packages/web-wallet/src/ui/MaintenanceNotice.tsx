import { useEffect, useState } from "react"
import { deviceStorage } from "../platform/storage/rollupStorage"
import { pauseWhenHidden } from "../platform/visibilityScheduler"
import { Warning } from "./Warning"

// ponytail: hard-coded window; delete this notice once it has passed.
const MAINTENANCE_ENDS = Date.UTC(2026, 9, 26, 13)
// Holds the dismissed window's end, so a later notice is not hidden by this one's dismissal.
const DISMISSED_KEY = "webwallet.hide-maintenance-notice"

function readDismissed(): boolean {
  try {
    return deviceStorage.getItem(DISMISSED_KEY) === String(MAINTENANCE_ENDS)
  } catch {
    return false
  }
}

/** Warns ahead of planned downtime; gone once the window ends or the user dismisses it. */
export function MaintenanceNotice() {
  const [dismissed, setDismissed] = useState(readDismissed)
  const [ended, setEnded] = useState(() => Date.now() >= MAINTENANCE_ENDS)
  // Home can stay open past the end, so keep checking.
  useEffect(() => {
    if (ended) return
    const timer = pauseWhenHidden.setInterval(
      () => setEnded(Date.now() >= MAINTENANCE_ENDS),
      60_000,
    )
    return () => pauseWhenHidden.clearInterval(timer)
  }, [ended])
  if (dismissed || ended) return null
  const dismiss = () => {
    setDismissed(true)
    try {
      deviceStorage.setItem(DISMISSED_KEY, String(MAINTENANCE_ENDS))
    } catch {
      // Storage blocked: hidden until the next visit only.
    }
  }
  return (
    <Warning
      title="Planned maintenance"
      style={{ marginTop: -16, marginBottom: -16 }}
      onDismiss={dismiss}
    >
      The wallet will be down for planned maintenance on 2026-10-26 at 7:30 UTC for about 5 hours.
    </Warning>
  )
}
