import { Icon } from "@obsidion/web-ds"
import "./aboutLimits.css"

/** An info icon that opens an explanation. A real button, so click, tap and keyboard all open it. */
export function InfoButton({
  label,
  onClick,
  testId = "about-limits-link",
}: {
  /** The accessible name, such as "About the deposit limit". */
  label: string
  onClick: () => void
  testId?: string
}) {
  return (
    <button
      type="button"
      className="zkm-btn-reset ww-info-button"
      aria-label={label}
      data-testid={testId}
      onClick={onClick}
    >
      <Icon name="info-circle" />
    </button>
  )
}
