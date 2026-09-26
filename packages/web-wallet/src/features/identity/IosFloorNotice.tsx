import { useEffect, useState } from "react"
import {
  IOS_FLOOR_COPY,
  currentDevicePosture,
  currentUserAgentInfo,
  iosBelowFloor,
} from "@obsidion/passkey-web"
import { Icon } from "@obsidion/web-ds"

/**
 * A warning, never a block, for a phone whose browser claims an iOS below the passkey floor. The
 * version is a claim (Safari freezes it), so the notice asks the user to check rather than
 * disabling anything.
 */
export function IosFloorNotice() {
  const [below, setBelow] = useState(false)
  useEffect(() => {
    if (currentDevicePosture() !== "phone") return
    let live = true
    void currentUserAgentInfo().then((info) => {
      if (live) setBelow(iosBelowFloor(info))
    })
    return () => {
      live = false
    }
  }, [])
  if (!below) return null
  return (
    <p className="ww-invite-modal-error" role="alert" data-testid="ios-floor-notice">
      <Icon name="alert-triangle" size={14} color="var(--accent-pink)" /> {IOS_FLOOR_COPY}
    </p>
  )
}
