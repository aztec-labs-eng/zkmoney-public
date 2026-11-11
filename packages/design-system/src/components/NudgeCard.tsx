import { Icon } from "./Icon"

export interface NudgeCardProps {
  title: string
  body: string
  action: { label: string; onClick: () => void }
  /** Omit when the nudge can't be put off, e.g. a step already under way. */
  onDismiss?: () => void
  /** Accessible name of the dismiss button. Default "Dismiss". */
  dismissLabel?: string
}

/** Gold card on Home or Settings that asks for one action. */
export function NudgeCard({
  title,
  body,
  action,
  onDismiss,
  dismissLabel = "Dismiss",
}: NudgeCardProps) {
  return (
    <div
      className={["zkm-nudge-card", onDismiss && "zkm-nudge-card--dismissible"]
        .filter(Boolean)
        .join(" ")}
    >
      <span className="zkm-nudge-card__icon">
        <Icon name="alert-fill" size={20} color="var(--accent-warning)" />
      </span>
      <div className="zkm-nudge-card__content">
        <div className="zkm-nudge-card__text">
          <div className="zkm-nudge-card__title">{title}</div>
          <div className="zkm-nudge-card__body">{body}</div>
        </div>
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable zkm-nudge-card__action"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      </div>
      {onDismiss && (
        <button
          type="button"
          className="zkm-btn-reset zkm-nudge-card__dismiss"
          aria-label={dismissLabel}
          onClick={onDismiss}
        >
          <Icon name="x" size={10} strokeWidth={3} />
        </button>
      )}
    </div>
  )
}
