import React from "react"
import { createRoot } from "react-dom/client"
import { missingBrowserFeatures } from "./browserSupport"
import { DESKTOP_SETTINGS_PATH } from "./platform/desktopBridge"
import { RESET_PATH, ResetScreen } from "./ui/ResetScreen"
import { UnsupportedBrowser } from "./ui/UnsupportedBrowser"

// A separate chunk, so `/reset` still loads when the wallet's own modules fail.
const WalletBoot = React.lazy(() => import("./walletBoot"))
// The launcher's settings page, in its own chunk too. Spelled inline so every other build folds the
// check to false and drops the chunk.
const DesktopSettings =
  import.meta.env.VITE_DESKTOP_BUILD === "true"
    ? React.lazy(() => import("./desktopSettings"))
    : null

/**
 * Renders render-time failures (a config error in `createAppServices`, a
 * provider throw) as text instead of a white screen. Pre-DS on purpose — the
 * design system itself may be what failed to load.
 */
class RootErrorBoundary extends React.Component<{ children: React.ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: "monospace", color: "#f66" }}>
          <p>zk.money failed to start:</p>
          <pre style={{ whiteSpace: "pre-wrap" }}>{this.state.error.message}</pre>
        </div>
      )
    }
    return this.props.children
  }
}

const missing = missingBrowserFeatures()

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      {location.pathname === RESET_PATH ? (
        <ResetScreen />
      ) : DesktopSettings && location.pathname === DESKTOP_SETTINGS_PATH ? (
        <React.Suspense fallback={null}>
          <DesktopSettings />
        </React.Suspense>
      ) : missing.length > 0 ? (
        <UnsupportedBrowser missing={missing} />
      ) : (
        <React.Suspense fallback={null}>
          <WalletBoot />
        </React.Suspense>
      )}
    </RootErrorBoundary>
  </React.StrictMode>,
)
