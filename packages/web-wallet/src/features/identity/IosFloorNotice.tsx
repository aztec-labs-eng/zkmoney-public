import { memoryStore, useStore } from "@obsidion/front-core"
import {
  IOS_FLOOR_COPY,
  currentDevicePosture,
  iosBelowFloor,
  type UserAgentInfo,
} from "@obsidion/passkey-web"
import { Icon } from "@obsidion/web-ds"
import { useSession } from "../../session/session"

/** Off a phone the notice reads no claims, so it starts no probe. */
const NO_CLAIMS = memoryStore<UserAgentInfo | undefined>(undefined).readonly

/**
 * A warning, never a block, for a phone whose browser claims an iOS below the passkey floor. The
 * version is a claim (Safari freezes it), so the notice warns rather than disabling anything.
 */
export function IosFloorNotice() {
  const { userAgent } = useSession().page
  const info = useStore(currentDevicePosture() === "phone" ? userAgent : NO_CLAIMS)
  if (!info || !iosBelowFloor(info)) return null
  return (
    <p className="ww-invite-modal-error" role="alert" data-testid="ios-floor-notice">
      <Icon name="alert-triangle" size={14} color="var(--accent-pink)" /> {IOS_FLOOR_COPY}
    </p>
  )
}
