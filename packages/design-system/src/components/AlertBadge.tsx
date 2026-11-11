export interface AlertBadgeProps {
  /** What needs attention, for screen readers. */
  label: string
  className?: string
}

/** Brand-gradient "!" dot on a nav item or row that leads to something needing attention. */
export function AlertBadge({ label, className }: AlertBadgeProps) {
  return (
    <span
      role="img"
      aria-label={label}
      className={["zkm-alert-badge", className].filter(Boolean).join(" ")}
    />
  )
}
