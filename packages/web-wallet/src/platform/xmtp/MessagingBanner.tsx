import { useSyncExternalStore } from "react"
import { getXmtpUiState, subscribeXmtpUiState, XMTP_STATE_COPY } from "./xmtpLifecycle"

/** Messaging-state banner for the contacts surfaces. Renders nothing when leader / off. */
export function MessagingBanner() {
  const state = useSyncExternalStore(subscribeXmtpUiState, getXmtpUiState)
  const message = XMTP_STATE_COPY[state]
  if (!message) return null
  return (
    <div
      role="status"
      style={{
        marginTop: 12,
        padding: "10px 14px",
        borderRadius: 12,
        background: "var(--surface-secondary, rgba(128,128,128,0.12))",
        color: "var(--text-secondary)",
        fontSize: 13,
      }}
    >
      {message}
    </div>
  )
}
