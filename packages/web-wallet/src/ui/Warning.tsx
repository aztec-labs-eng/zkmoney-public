import type { CSSProperties, ReactNode } from "react"
import { Icon } from "@obsidion/web-ds"

export type WarningTone = "warning" | "success" | "error"

const TONE_ICON = {
  success: "shield-check",
  warning: "alert-circle",
  error: "alert-triangle",
} as const

/** Inline warning card. With a body it shows only its title until tapped open. */
export function Warning({
  title,
  tone,
  role = "status",
  style,
  children,
}: {
  title: ReactNode
  tone?: WarningTone
  role?: "status" | "note" | "alert"
  style?: CSSProperties
  children?: ReactNode
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
        <Icon name={TONE_ICON[tone ?? "warning"]} size={18} />
        {title}
        <Icon name="chevron-down" size={16} className="ww-withdraw__warning-chevron" />
      </summary>
      <div className="ww-withdraw__warning-body">{children}</div>
    </details>
  )
}
