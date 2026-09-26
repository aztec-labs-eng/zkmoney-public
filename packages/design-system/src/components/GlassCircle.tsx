import type { CSSProperties, ReactNode } from "react"
import { Icon } from "./Icon"

export interface GlassCircleButtonProps {
  /** Omit to render a non-interactive decorative circle. */
  onClick?: () => void
  size?: number
  children: ReactNode
  ariaLabel?: string
  className?: string
  style?: CSSProperties
}

/**
 * 40x40 liquid-glass circle icon button used in nav bars and trailing slots.
 * Without `onClick` it renders as decorative chrome.
 */
export function GlassCircleButton({ onClick, size = 40, children, ariaLabel, className, style }: GlassCircleButtonProps) {
  const cls = ["zkm-glass-circle zkm-glass-circle--faint", className].filter(Boolean).join(" ")
  const dim = { width: size, height: size, ...style }
  if (!onClick) {
    return (
      <div className={cls} style={dim}>
        {children}
      </div>
    )
  }
  return (
    <button type="button" className={`zkm-btn-reset ${cls}`} style={dim} onClick={onClick} aria-label={ariaLabel}>
      {children}
    </button>
  )
}

export interface IconCircleProps {
  /** Icon name (canonical or SF Symbol alias). */
  name: string
  /** Circle diameter. Default 44. */
  size?: number
  /** Glyph size. Default 18. */
  glyphSize?: number
  className?: string
}

/** Liquid-glass circle hosting an icon — settings rows, method icons. Brighter fill than GlassCircleButton. */
export function IconCircle({ name, size = 44, glyphSize = 18, className }: IconCircleProps) {
  return (
    <div
      className={["zkm-glass-circle zkm-glass-circle--bright", className].filter(Boolean).join(" ")}
      style={{ width: size, height: size }}
    >
      <Icon name={name} size={glyphSize} color="#fff" strokeWidth={2.2} />
    </div>
  )
}

/** Muted right chevron used at the trailing edge of tappable rows. */
export function RowChevron() {
  return <Icon name="chevron-right" size={12} color="rgba(255,255,255,0.5)" strokeWidth={2.5} />
}
