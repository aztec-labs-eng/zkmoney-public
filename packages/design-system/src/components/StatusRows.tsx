import { useId } from "react"
import { Icon } from "./Icon"

export interface ChecklistRowProps {
  /** Green tick when done; gold warning when it still needs doing. */
  done: boolean
  label: string
  detail?: string
  /** Grays a finished item so the open ones stand out. */
  muted?: boolean
  /** Underlined link at the trailing edge, e.g. "Review". */
  action?: { label: string; onClick: () => void }
}

/** A condition on a sheet's checklist. Group rows in a `SheetCard`. */
export function ChecklistRow({ done, label, detail, muted, action }: ChecklistRowProps) {
  const labelId = useId()
  return (
    <div
      className={["zkm-checklist-row", muted && "zkm-checklist-row--muted"]
        .filter(Boolean)
        .join(" ")}
    >
      {done ? (
        <Icon name="check-circle-fill" size={22} color="var(--accent-green)" />
      ) : (
        <Icon name="alert-fill" size={22} color="var(--accent-warning)" />
      )}
      <span className="zkm-checklist-row__text">
        <span id={labelId} className="zkm-checklist-row__label">
          {label}
        </span>
        {detail && <span className="zkm-checklist-row__detail">{detail}</span>}
      </span>
      {action && (
        // Names the row it acts on, so "Review" alone is not all a screen reader hears.
        <button
          type="button"
          className="zkm-btn-reset zkm-sheet-link"
          aria-describedby={labelId}
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}

export interface KeyStatusRowProps {
  /** e.g. "Sign-up passkey". */
  name: string
  /** e.g. "This Mac · iCloud Keychain" or "Not added". */
  detail: string
  status: "added" | "missing"
}

/** One passkey on the account: key icon, name and where it lives, then a tick or a warning. */
export function KeyStatusRow({ name, detail, status }: KeyStatusRowProps) {
  return (
    <div className="zkm-key-status-row">
      <span className="zkm-key-status-row__icon">
        <Icon name="key-fill" size={18} color="var(--ink)" />
      </span>
      <span className="zkm-key-status-row__text">
        <span className="zkm-key-status-row__name">{name}</span>
        <span className="zkm-key-status-row__detail">{detail}</span>
      </span>
      {status === "added" ? (
        <span className="zkm-key-status-row__added">
          <Icon name="check-micro" size={12} />
        </span>
      ) : (
        <Icon name="alert-fill" size={20} color="var(--accent-warning)" />
      )}
    </div>
  )
}
