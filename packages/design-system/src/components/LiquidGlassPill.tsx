import type { CSSProperties, ReactNode } from "react"
import { Icon } from "./Icon"

export interface LiquidGlassPillProps {
  label: string
  /** Icon name (canonical or SF Symbol alias). */
  icon?: string
  /** Custom icon node; takes precedence over `icon`. */
  customIcon?: ReactNode
  /** Icon before the label instead of after. Default false. */
  iconLeading?: boolean
  /** Text/icon color. Default white. */
  foreground?: string
  /** Tint overlay color (e.g. gold for request chips). */
  tint?: string
  /** Tint overlay opacity. Default 0 (off). */
  tintOpacity?: number
  /** Fallback capsule fill. Default rgba(255,255,255,0.03). */
  fallbackFill?: string
  labelFontSize?: number
  labelTracking?: number
  iconFontSize?: number
  horizontalPadding?: number
  verticalPadding?: number
  shadowRadius?: number
  className?: string
  style?: CSSProperties
}

/**
 * Base liquid-glass capsule `[icon] [label]` primitive — transaction kind
 * chips, role chips on amount cards, chat-bubble tags.
 */
export function LiquidGlassPill({
  label,
  icon,
  customIcon,
  iconLeading = false,
  foreground = "#fff",
  tint,
  tintOpacity = 0,
  fallbackFill = "rgba(255,255,255,0.03)",
  labelFontSize = 10,
  labelTracking = 0,
  iconFontSize = 9,
  horizontalPadding = 8,
  verticalPadding = 2,
  shadowRadius = 4,
  className,
  style,
}: LiquidGlassPillProps) {
  const iconNode = customIcon ?? (icon ? <Icon name={icon} size={iconFontSize + 3} /> : null)
  const background =
    tint && tintOpacity > 0
      ? `linear-gradient(0deg, ${hexOpacity(tint, tintOpacity)}, ${hexOpacity(tint, tintOpacity)}), ${fallbackFill}`
      : fallbackFill
  return (
    <span
      className={["zkm-glass-pill", className].filter(Boolean).join(" ")}
      style={{
        color: foreground,
        background,
        padding: `${verticalPadding}px ${horizontalPadding}px`,
        boxShadow: `0 0 ${shadowRadius}px rgba(0,0,0,0.1)`,
        fontSize: labelFontSize,
        letterSpacing: labelTracking,
        ...style,
      }}
    >
      {iconLeading && iconNode}
      <span>{label}</span>
      {!iconLeading && iconNode}
    </span>
  )
}

function hexOpacity(color: string, opacity: number): string {
  if (color.startsWith("#") && (color.length === 7 || color.length === 4)) {
    const hex = color.length === 4 ? `#${[1, 2, 3].map((i) => color[i] + color[i]).join("")}` : color
    const a = Math.round(opacity * 255)
      .toString(16)
      .padStart(2, "0")
    return `${hex}${a}`
  }
  return color
}
