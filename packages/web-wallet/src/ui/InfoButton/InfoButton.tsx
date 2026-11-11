import { Icon } from "@obsidion/web-ds"
import type { IconName } from "@obsidion/web-ds"
import styles from "./InfoButton.module.css"

/** An info icon that opens an explanation. A real button, so click, tap and keyboard all open it. */
export function InfoButton({
  label,
  onClick,
  testId = "about-limits-link",
  icon = "info-circle",
  className,
  describedBy,
  outline = false,
}: {
  /** The accessible name, such as "About the deposit limit". */
  label: string
  /** Absent for an icon whose explanation opens on hover and focus. */
  onClick?: () => void
  testId?: string
  icon?: IconName
  className?: string
  describedBy?: string
  /** A 12px ring with no fill, as on the review's Fee. */
  outline?: boolean
}) {
  return (
    <button
      type="button"
      className={["zkm-btn-reset", styles.button, outline && styles.outline, className]
        .filter(Boolean)
        .join(" ")}
      aria-label={label}
      aria-describedby={describedBy}
      data-testid={testId}
      onClick={onClick}
    >
      <Icon name={outline ? "information-line" : icon} />
    </button>
  )
}
