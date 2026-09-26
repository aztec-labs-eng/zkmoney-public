import type { CSSProperties, ReactNode } from "react"

export interface CardProps {
  children: ReactNode
  /** Corner radius. Default 12. */
  radius?: number
  /** Inner padding. Default 12. */
  padding?: number | string
  className?: string
  style?: CSSProperties
}

/**
 * Translucent rounded card surface (white @ 5%) used for row groups,
 * transaction cards, and content panels over the dark background.
 */
export function Card({ children, radius = 12, padding = 12, className, style }: CardProps) {
  return (
    <div
      className={["zkm-card", className].filter(Boolean).join(" ")}
      style={{ borderRadius: radius, padding, ...style }}
    >
      {children}
    </div>
  )
}
