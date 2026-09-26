import type { ReactNode } from "react"
import { GradientInitialAvatar } from "./Avatars"
import { Icon } from "./Icon"
import { StatusBadge, type StatusBadgeStyle } from "./StatusPill"

export interface TransactionRowAction {
  title: string
  /** "neutral" = translucent capsule; "gradient" = brand gradient capsule. */
  actionStyle?: "neutral" | "gradient"
  /** Optional leading icon (the app uses "share"). */
  icon?: string
  onClick?: () => void
}

export interface ActivityListRowProps {
  counterparty: string
  /** Gold badge text next to the name (e.g. "Requested"). */
  counterpartyBadge?: string
  /** Pre-formatted timestamp line (e.g. "Today, 11:15"). */
  timestamp: string
  /** Signed amount string; a "+" prefix renders green. */
  amount: string
  /** Status label under the amount (Pending / Unclaimed / Unpaid / Claimed / Migrated / You owe / Failed / Needs recovery / Recovered / Cancelled / Refunded / Expired / Paid). */
  statusLabel?: StatusLabel
  /** Avatar node; defaults to a deterministic gradient-initial avatar from `counterparty`. */
  avatar?: ReactNode
  /** Icon name rendered on a brand-gradient disc instead of the initial avatar (e.g. "link", "wallet"). */
  avatarIcon?: string
  /** Action buttons under the row (e.g. Claim / Share). */
  actions?: TransactionRowAction[]
  /** Optional interaction for the informational top area; action buttons remain separate. */
  onClick?: () => void
  ariaLabel?: string
  className?: string
}

export const STATUS_STYLE = {
  "Failed": "failed",
  "Expired": "failed",
  "Needs recovery": "failed",
  "Cancelled": "cancelled",
  "Recovered": "cancelled",
  "Refunded": "cancelled",
  "Owes you": "request",
  "You owe": "request",
  "Pending": "pending",
  // A withdrawal between the burn and the payout: still in flight, so the pending orange.
  "Releasing": "pending",
  "Swapping": "pending",
  // Money has arrived but is not credited yet — the same in-flight orange a deposit row wears,
  // since that is the deposit this row stands in for.
  "Payment detected": "pending",
  "Claimed": "pending",
  "Migrated": "pending",
  "Unclaimed": "awaitingClaim",
  "Unpaid": "awaitingClaim",
  "Paid": "paid",
} as const satisfies Record<string, StatusBadgeStyle>

/** A row label this component draws a badge for. Callers type their label maps with it. */
export type StatusLabel = keyof typeof STATUS_STYLE

/**
 * The badge style a row label draws, or undefined for a label this component styles no badge for —
 * in which case the row renders NO badge and the state goes invisible. Exported so callers can pin
 * the labels they emit in a test rather than discovering the silence in the UI.
 */
export function statusBadgeStyle(label: string): StatusBadgeStyle | undefined {
  return (STATUS_STYLE as Record<string, StatusBadgeStyle | undefined>)[label]
}

/**
 * Activity-feed transaction row card: avatar + counterparty + timestamp on the
 * left, amount + status badge on the right, optional action buttons beneath.
 */
export function ActivityListRow({
  counterparty,
  counterpartyBadge,
  timestamp,
  amount,
  statusLabel,
  avatar,
  avatarIcon,
  actions = [],
  onClick,
  ariaLabel,
  className,
}: ActivityListRowProps) {
  const credit = amount.trim().startsWith("+")
  const badgeStyle = statusLabel ? statusBadgeStyle(statusLabel) : undefined
  const avatarNode =
    avatar ??
    (avatarIcon ? (
      <div className="zkm-avatar__disc zkm-activity-row__glyph">
        <Icon name={avatarIcon} size={20} color="#fff" />
      </div>
    ) : (
      <GradientInitialAvatar name={counterparty} size={44} />
    ))
  const top = (
    <>
      {avatarNode}
      <div className="zkm-activity-row__who">
        <div className="zkm-activity-row__name-line">
          <span
            className={
              // Long titles (addresses, sentences) get a readable shrink floor; see styles.css.
              counterparty.length > 8
                ? "zkm-activity-row__name zkm-activity-row__name--long"
                : "zkm-activity-row__name"
            }
          >
            {counterparty}
          </span>
          {counterpartyBadge && (
            <span className="zkm-activity-row__name-badge">{counterpartyBadge}</span>
          )}
        </div>
        <span className="zkm-activity-row__time">{timestamp}</span>
      </div>
      <div className="zkm-activity-row__right">
        <span
          className="zkm-activity-row__amount"
          style={credit ? { color: "var(--accent-green)" } : undefined}
        >
          {amount}
        </span>
        {statusLabel && badgeStyle && <StatusBadge label={statusLabel} badgeStyle={badgeStyle} />}
      </div>
    </>
  )
  return (
    <div className={["zkm-activity-row", className].filter(Boolean).join(" ")}>
      {onClick ? (
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable zkm-activity-row__top"
          aria-label={ariaLabel}
          onClick={onClick}
        >
          {top}
        </button>
      ) : (
        <div className="zkm-activity-row__top">{top}</div>
      )}
      {actions.length > 0 && (
        <div className="zkm-activity-row__actions">
          {actions.map((a) => (
            <button
              key={a.title}
              type="button"
              className={`zkm-btn-reset zkm-pressable zkm-activity-action zkm-activity-action--${
                a.actionStyle ?? "neutral"
              }`}
              onClick={a.onClick}
            >
              {a.icon && <Icon name={a.icon} size={16} />}
              {a.title}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
