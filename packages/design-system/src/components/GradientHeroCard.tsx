import type { CSSProperties, ReactNode } from "react"

export interface GradientHeroCardProps {
  /** Centered slot above the title (avatar, logo…). */
  avatar?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  /** Dark strip attached under the gradient body (e.g. lock icon + "reserved"). */
  footer?: ReactNode
  className?: string
  style?: CSSProperties
}

/**
 * Campaign hero: brand-gradient panel with centered avatar / title / subtitle
 * and an optional dark footer strip attached below.
 */
export function GradientHeroCard({ avatar, title, subtitle, footer, className, style }: GradientHeroCardProps) {
  return (
    <div className={["zkm-hero-card", className].filter(Boolean).join(" ")} style={style}>
      <div className="zkm-hero-card__body">
        {avatar}
        <div className="zkm-hero-card__title">{title}</div>
        {subtitle && <div className="zkm-hero-card__subtitle">{subtitle}</div>}
      </div>
      {footer && <div className="zkm-hero-card__footer">{footer}</div>}
    </div>
  )
}
