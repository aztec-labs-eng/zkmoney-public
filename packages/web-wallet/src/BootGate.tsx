import React from "react"
import { UNSUPPORTED_BROWSER_MESSAGE } from "@obsidion/passkey-web"
import { App } from "./App"
import type { WebBootConfig } from "./config/env"
import { WebLocksUnavailableError } from "./platform/storage/webLock"
import { BootSplash } from "./ui/PxeBoot"

/** Account consumers mount only after configuration and session cleanup succeed. */
export function BootGate({ resolveBoot }: { resolveBoot: () => Promise<WebBootConfig> }) {
  const [boot, setBoot] = React.useState<WebBootConfig>()
  const [error, setError] = React.useState<Error>()
  const [attempt, setAttempt] = React.useState(0)
  const bootAttempt = React.useRef<Promise<WebBootConfig> | undefined>(undefined)

  React.useEffect(() => {
    let live = true
    // StrictMode's repeated effect shares the same cleanup and configuration attempt.
    void (bootAttempt.current ??= resolveBoot()).then(
      (resolved) => live && setBoot(resolved),
      (e: Error) => live && setError(e),
    )
    return () => {
      live = false
    }
  }, [attempt, resolveBoot])

  if (error instanceof WebLocksUnavailableError) {
    return (
      <div role="alert" style={{ padding: 24 }}>
        <h1>Browser not supported</h1>
        <p>{UNSUPPORTED_BROWSER_MESSAGE}</p>
      </div>
    )
  }
  if (error) {
    return (
      <div style={{ padding: 24, fontFamily: "monospace", color: "#f66" }}>
        <p>zk.money could not load its configuration:</p>
        <pre style={{ whiteSpace: "pre-wrap" }}>{error.message}</pre>
        <button
          onClick={() => {
            bootAttempt.current = undefined
            setError(undefined)
            setAttempt((n) => n + 1)
          }}
        >
          Retry
        </button>
      </div>
    )
  }
  if (!boot) {
    return <BootSplash />
  }
  return <App boot={boot} />
}
