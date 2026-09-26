import { useEffect, useRef } from "react"
import { Card, PrimaryGradientButton } from "@obsidion/web-ds"
import { ANALYTICS_CONSENT_COPY } from "../../lib/analytics"

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
