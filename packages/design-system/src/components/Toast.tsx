import { Icon } from "./Icon"
import { Spinner } from "./Effects"

export type ToastKind = "success" | "error" | "progress"

const KIND_ICON: Record<Exclude<ToastKind, "progress">, { name: string; color: string }> = {
  success: { name: "check-circle", color: "#56E79D" },
  error: { name: "alert-circle", color: "#FE708B" },
}

export interface ToastProps {
  kind: ToastKind
  message: string
  /** Trailing action label (e.g. "Open"). */
  actionLabel?: string
  onAction?: () => void
  /** Trailing dismiss ✕. */
  onDismiss?: () => void
  className?: string
}

/**
 * Dark pill toast: status icon + message + optional trailing action or ✕.
 * "progress" shows a spinner (e.g. "Keeping it private…" while proving).
 */
export function Toast({ kind, message, actionLabel, onAction, onDismiss, className }: ToastProps) {
  return (
    <div className={["zkm-toast", className].filter(Boolean).join(" ")}>
      {kind === "progress" ? (
        <Spinner size={16} color="#A000FF" />
      ) : (
        <Icon name={KIND_ICON[kind].name} size={18} color={KIND_ICON[kind].color} />
      )}
      <span className="zkm-toast__message">{message}</span>
      {actionLabel && (
        <button type="button" className="zkm-btn-reset zkm-toast__action" onClick={onAction}>
          {actionLabel}
        </button>
      )}
      {onDismiss && (
        <button type="button" className="zkm-btn-reset zkm-toast__dismiss" onClick={onDismiss} aria-label="Dismiss">
          <Icon name="x" size={14} strokeWidth={2.5} />
        </button>
      )}
    </div>
  )
}
