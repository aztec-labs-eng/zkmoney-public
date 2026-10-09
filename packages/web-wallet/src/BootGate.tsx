import React from "react"
import { ActiveTabGate } from "./ActiveTabGate"
import type { WebBootConfig } from "./config/env"
import { GOOGLE_CALLBACK_PATH, GoogleCallbackScreen } from "./features/paylink/googleAuth"
import { getDesktopSettingsPath } from "./platform/desktopBridge"
import { BootSplash } from "./ui/PxeBoot"
import { PreviewDraftRecovery } from "./dev/PreviewDraftRecovery"

export function BootGate({ resolveBoot }: { resolveBoot: () => Promise<WebBootConfig> }) {
  const [boot, setBoot] = React.useState<WebBootConfig>()
  const [error, setError] = React.useState<Error>()
  const [attempt, setAttempt] = React.useState(0)
  const bootAttempt = React.useRef<Promise<WebBootConfig> | undefined>(undefined)

  React.useEffect(() => {
    let live = true
    // StrictMode's repeated effect shares the same configuration attempt.
    void (bootAttempt.current ??= resolveBoot()).then(
      (resolved) => live && setBoot(resolved),
      (e: Error) => live && setError(e),
    )
    return () => {
      live = false
    }
  }, [attempt, resolveBoot])

  const retry = () => {
    bootAttempt.current = undefined
    setError(undefined)
    setAttempt((n) => n + 1)
  }
  // The screen's only way on, so it must be a comfortable tap.
  const retryButton = (
    <button onClick={retry} style={{ minHeight: 44, padding: "0 20px", fontSize: 16 }}>
      Retry
    </button>
  )

  if (error) {
    const settingsPath = getDesktopSettingsPath()
    return (
      <div style={{ padding: 24, fontFamily: "monospace", color: "#f66" }}>
        <p>zk.money could not load its configuration:</p>
        <pre style={{ whiteSpace: "pre-wrap" }}>{error.message}</pre>
        {settingsPath && (
          <p>
            If zk.money's services are down, <a href={settingsPath}>Endpoint Settings</a> can point
            the wallet at other services or start it from the configuration it shipped with.
          </p>
        )}
        {retryButton}
        {import.meta.env.VITE_CONFIG_EDITOR === "true" && <PreviewDraftRecovery />}
      </div>
    )
  }
  if (!boot) {
    return <BootSplash />
  }
  // Google's OAuth popup only relays a token to its opener, the active tab, so it skips the gate,
  // which would stop it at the other-tab screen. It still waits for the configuration: the relay
  // writes to the partition of the rollup the configuration names.
  if (location.pathname === GOOGLE_CALLBACK_PATH) return <GoogleCallbackScreen />
  return <ActiveTabGate boot={boot} />
}
