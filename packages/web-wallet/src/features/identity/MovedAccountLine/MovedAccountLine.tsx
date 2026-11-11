import { useState } from "react"
import { useStore } from "@obsidion/front-core"
import { useSession } from "../../../session/session"
import { clearMovedAccountMark, movedAccountMark } from "../movedAccount"
import copy from "./MovedAccountLine.copy"

/**
 * Home's one-time line after the page reloaded into the account a backup add on another device
 * moved the wallet to. The mark is read and cleared as the line mounts, so it shows on this load
 * alone.
 */
export function MovedAccountLine() {
  const [mark] = useState(() => {
    const mark = movedAccountMark()
    clearMovedAccountMark()
    return mark
  })
  const [dismissed, setDismissed] = useState(false)
  const identity = useStore(useSession().identity).value
  const show =
    !dismissed &&
    mark !== undefined &&
    identity !== null &&
    identity.address.toLowerCase() === mark.toLowerCase()
  if (!show) return null
  return (
    <div
      className="ww-banner ww-banner--static"
      data-testid="moved-account-line"
      aria-live="polite"
    >
      <span className="ww-banner__text">
        <span className="ww-banner__body">{copy.body}</span>
      </span>
      <button
        type="button"
        className="zkm-btn-reset ww-deposit__link"
        onClick={() => setDismissed(true)}
        data-testid="moved-account-dismiss"
      >
        {copy.ok}
      </button>
    </div>
  )
}
