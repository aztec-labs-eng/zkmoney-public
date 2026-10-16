import { useEffect, useRef, useSyncExternalStore } from "react"
import { useConfigValue } from "@obsidion/front-core"
import { Card, PrimaryGradientButton } from "@obsidion/web-ds"
import { isDemoMode } from "../../dev/demoFlag"
import { ANALYTICS_CONSENT_COPY } from "../../lib/analytics"
import { walletStorage } from "../../platform/storage/walletStorage"
import { loadWalletIdentity } from "../identity/walletIdentity"

const onboardingEnded = () => {
  const identity = loadWalletIdentity()
  return !!identity && !identity.pending
}

/** Asks once, in the wallet, after onboarding ends: the identity holds no pending tag. */
export function AnalyticsConsentPrompt() {
  const { value: asked, setValue: setAsked } = useConfigValue("analyticsAsked")
  const { setValue: setConsent } = useConfigValue("analyticsConsent")
  const ended = useSyncExternalStore(walletStorage.onCommit, onboardingEnded)
  if (asked || !ended || isDemoMode()) return null
  return (
    <AnalyticsConsentModal
      onChoose={(granted) => {
        void setConsent(granted).then(() => setAsked(true))
      }}
    />
  )
}

/**
 * One-time opt-in prompt for anonymous usage analytics. Choice persists in local config.
 * `showModal()` supplies the backdrop, the focus trap, and inert background content; the cancel
 * handler makes Esc a decline rather than a dismissal that leaves the question unanswered.
 */
export function AnalyticsConsentModal({ onChoose }: { onChoose: (granted: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  return (
    <dialog
      ref={ref}
      className="ww-consent-dialog"
      onCancel={(e) => {
        e.preventDefault()
        onChoose(false)
      }}
    >
      <Card
        radius={16}
        padding={24}
        style={{
          background: "var(--surface-sheet)",
          boxShadow: "0 24px 80px rgba(0, 0, 0, 0.55), inset 0 0 0 1px rgba(255, 255, 255, 0.06)",
        }}
      >
        <h2
          className="zkm-type-title-sm"
          style={{
            margin: "0 0 8px",
            color: "var(--text-primary)",
            fontFamily: "var(--font-display)",
          }}
        >
          Help improve zk.money
        </h2>
        <p
          className="zkm-type-body"
          style={{ margin: "0 0 20px", color: "var(--text-secondary)", lineHeight: 1.5 }}
        >
          {ANALYTICS_CONSENT_COPY}
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <PrimaryGradientButton title="Share anonymous data" onClick={() => onChoose(true)} />
          <PrimaryGradientButton
            title="No thanks"
            buttonStyle="dark"
            onClick={() => onChoose(false)}
          />
        </div>
      </Card>
    </dialog>
  )
}
