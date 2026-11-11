import { bestEffort } from "@obsidion/core/errors"
import { PrimaryGradientButton } from "@obsidion/web-ds"
import { useStore, type QueryEntry } from "@obsidion/front-core"
import { ActiveTabGate } from "./ActiveTabGate/ActiveTabGate"
import type { PageBoot } from "./app/sessionDeps"
import { GoogleCallbackScreen } from "./features/paylink/googleAuth"
import { GOOGLE_CALLBACK_PATH } from "./features/paylink/googleRelay"
import { getDesktopSettingsPath } from "./platform/desktopBridge"
import { BOOT_ERROR_LAYOUT } from "./ui/BootErrorScreen"
import { PreBootLayer } from "./ui/PreBootLayer"
import { BootSplash } from "./ui/PxeBoot"
import { PreviewDraftRecovery } from "./dev/PreviewDraftRecovery"

/** The page's configuration, read once the gate subscribes. */
export function BootGate({ boot: read }: { boot: QueryEntry<PageBoot> }) {
  const state = useStore(read)
  const boot = state.status === "ready" ? state.value : undefined
  const error = state.status === "failed" ? (state.error as Error) : undefined
  const retry = () => void bestEffort("unknown", read.read())

  if (error) {
    const settingsPath = getDesktopSettingsPath()
    return (
      <div role="alert" style={BOOT_ERROR_LAYOUT}>
        <span className="zkm-type-card-title">zk.money could not load its configuration</span>
        <span
          className="zkm-type-body"
          style={{ color: "var(--text-secondary)", overflowWrap: "anywhere" }}
        >
          {/* eslint-disable-next-line local/message-in-state -- debt */}
          {error.message}
        </span>
        {settingsPath && (
          <span className="zkm-type-body" style={{ color: "var(--text-secondary)" }}>
            If zk.money's services are down, <a href={settingsPath}>Endpoint Settings</a> can point
            the wallet at other services or start it from the configuration it shipped with.
          </span>
        )}
        <PrimaryGradientButton title="Retry" onClick={retry} />
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
  return (
    <>
      <ActiveTabGate boot={boot} />
      <PreBootLayer
        preBoot={boot.page.preBoot}
        page={boot.page}
        landingRate={boot.page.landingRate}
        ticketOffer={boot.page.ticketOffer}
      />
    </>
  )
}
