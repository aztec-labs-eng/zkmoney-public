import type { CSSProperties, ReactNode } from "react"

export interface BackgroundProps {
  children?: ReactNode
  className?: string
  style?: CSSProperties
}

/**
 * Full-bleed screen background: three stacked radial washes (violet, indigo, cyan)
 * over #070707. Fills its positioned parent (position: relative + overflow: hidden).
 */
export function AuroraBackground({ children, className, style }: BackgroundProps) {
  return (
    <div className={["zkm-bg zkm-bg--aurora", className].filter(Boolean).join(" ")} style={style}>
      <div className="zkm-bg__content">{children}</div>
    </div>
  )
}

export interface RadialPurpleBackgroundProps extends BackgroundProps {
  /** Edge the glow bleeds past. Default "top". */
  anchor?: "top" | "bottom"
}

/**
 * Full-bleed screen background: purple→cyan radial glow past the top or bottom
 * edge over #070707. Fills its positioned parent (position: relative + overflow: hidden).
 */
export function RadialPurpleBackground({ anchor = "top", children, className, style }: RadialPurpleBackgroundProps) {
  return (
    <div className={["zkm-bg", className].filter(Boolean).join(" ")} style={style}>
      <div className={`zkm-bg-radial-glow zkm-bg-radial-glow--${anchor}`} />
      <div className="zkm-bg__content">{children}</div>
    </div>
  )
}

/**
 * Full-bleed screen background: one large blurred purple→blue elliptical blob
 * rotated across the upper-left of #070707. Fills its positioned parent
 * (position: relative + overflow: hidden).
 */
export function PurpleBlueGradientBackground({ children, className, style }: BackgroundProps) {
  return (
    <div className={["zkm-bg", className].filter(Boolean).join(" ")} style={style}>
      <div className="zkm-bg-purpleblue__blob" />
      <div className="zkm-bg__content">{children}</div>
    </div>
  )
}

/**
 * Full-bleed profile/security screen background: three heavily blurred color
 * blobs hugging the left edge of #070707 (purple dominant, on top). Fills its
 * positioned parent (position: relative + overflow: hidden).
 */
export function ProfileBackground({ children, className, style }: BackgroundProps) {
  return (
    <div className={["zkm-bg", className].filter(Boolean).join(" ")} style={style}>
      <div className="zkm-bg-profile__blob zkm-bg-profile__blob--cyan" />
      <div className="zkm-bg-profile__blob zkm-bg-profile__blob--indigo" />
      <div className="zkm-bg-profile__blob zkm-bg-profile__blob--purple" />
      <div className="zkm-bg__content">{children}</div>
    </div>
  )
}

/**
 * Full-bleed modal background: #0B0B0B with an upper-left purple radial blob.
 * Fills its positioned parent (position: relative + overflow: hidden).
 */
export function ModalBackground({ children, className, style }: BackgroundProps) {
  return (
    <div className={["zkm-bg zkm-bg--modal", className].filter(Boolean).join(" ")} style={style}>
      <div className="zkm-bg__content">{children}</div>
    </div>
  )
}
