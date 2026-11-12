import { Icon } from "./Icon"

export interface StatusPillProps {
  label: string
  /** Leading icon; omit for a label-only pill (e.g. "Unverified"). */
  icon?: string
  /** Label color. Default white. */
  labelColor?: string
  /** Icon color. Default white. */
  iconColor?: string
  className?: string
}

/**
 * Flat status tag — `[icon] label` on translucent white, 4px radius.
 * Distinct from LiquidGlassPill (capsule, 10px label): this is the prominent
 * state indicator (Successful / Unclaimed / You owe / Unverified).
 */
export function StatusPill({ label, icon, labelColor = "var(--ink)", iconColor = "var(--ink)", className }: StatusPillProps) {
  return (
    <span className={["zkm-status-pill", className].filter(Boolean).join(" ")}>
      {icon && <Icon name={icon} size={14} color={iconColor} />}
      <span style={{ color: labelColor }}>{label}</span>
    </span>
  )
}

export type StatusBadgeStyle = "pending" | "awaitingClaim" | "request" | "failed" | "cancelled" | "paid"

const BADGE_COLORS: Record<StatusBadgeStyle, string> = {
  pending: "var(--accent-orange)",
  awaitingClaim: "var(--accent-gold)",
  request: "var(--accent-gold)",
  failed: "var(--accent-pink)",
  cancelled: "var(--text-secondary)",
  paid: "var(--accent-green)",
}

const BADGE_CLOCK: Record<StatusBadgeStyle, boolean> = {
  pending: true,
  awaitingClaim: true,
  request: true,
  failed: false,
  cancelled: false,
  paid: false,
}

export interface StatusBadgeProps {
  label: string
  badgeStyle: StatusBadgeStyle
  className?: string
}

/** Tiny colored capsule under a row amount (Pending / Unclaimed / You owe / Failed / Cancelled). */
export function StatusBadge({ label, badgeStyle, className }: StatusBadgeProps) {
  const color = BADGE_COLORS[badgeStyle]
  return (
    <span
      className={["zkm-status-badge", className].filter(Boolean).join(" ")}
      style={{ color, background: `color-mix(in srgb, ${color} 3%, transparent)` }}
    >
      <span>{label}</span>
      {BADGE_CLOCK[badgeStyle] && <Icon name="clock" size={12} />}
    </span>
  )
}
