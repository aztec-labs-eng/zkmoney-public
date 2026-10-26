import type { CSSProperties, ReactNode } from "react"
import { Icon } from "@obsidion/web-ds"

export type WarningTone = "warning" | "success" | "error" | "info"

/** An info note leads with its title alone. */
const TONE_ICON: Record<WarningTone, string | undefined> = {
  success: "shield-check",
  warning: "alert-circle",
  error: "alert-triangle",
  info: undefined,
}

/** Inline warning card. With a body it shows only its title until tapped open. */
export function Warning({
  title,
  tone,
  role = "status",
  style,
  children,
  onDismiss,
}: {
  title: ReactNode
  tone?: WarningTone
  role?: "status" | "note" | "alert"
  style?: CSSProperties
  children?: ReactNode
  /** Adds a close button to a card with a body. */
  onDismiss?: () => void
}) {
  if (!children) {
    return (
      <p className="ww-withdraw__warning" data-tone={tone} role={role} style={style}>
        {title}
      </p>
    )
  }
  return (
    <details className="ww-withdraw__warning" data-tone={tone} role={role} style={style}>
      <summary className="ww-withdraw__warning-head">
        {TONE_ICON[tone ?? "warning"] && <Icon name={TONE_ICON[tone ?? "warning"]!} size={18} />}
        {title}
        <Icon name="chevron-down" size={16} className="ww-withdraw__warning-chevron" />
        {onDismiss && (
          <button
            type="button"
            className="zkm-btn-reset ww-withdraw__warning-dismiss"
            aria-label="Dismiss"
            onClick={(e) => {
              // Inside the summary, so it would also toggle the card.
              e.preventDefault()
              onDismiss()
            }}
          >
            <Icon name="x" size={14} strokeWidth={2.5} />
          </button>
        )}
      </summary>
      <div className="ww-withdraw__warning-body">{children}</div>
    </details>
  )
}
