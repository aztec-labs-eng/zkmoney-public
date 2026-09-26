import type { CSSProperties, ReactNode } from "react"
import { GradientInitialAvatar } from "./Avatars"
import { Spinner } from "./Effects"

const DEFAULT_AVATAR_COLORS: readonly [string, string] = ["#A000FF", "#0099FF"]

/** "$" currency, 0 fraction digits when whole else 2. */
function formatBalance(balance: number): string {
  return Number.isInteger(balance) ? `$${balance}` : `$${balance.toFixed(2)}`
}

export interface AmountSourceCardProps {
  senderName: string
  senderHandle: string
  /** Avatar gradient pair. Default brand purple→cyan. */
  senderAvatarColors?: readonly [string, string]
  balance: number
  /** Amount view at the trailing edge (text, input, or formatted node). */
  amount: ReactNode
  className?: string
  style?: CSSProperties
}

/**
 * Amount-entry source card for send/request amount screens: "From:" + balance
 * header row, then avatar + name/handle with the amount slot at the trailing edge.
 */
export function AmountSourceCard({
  senderName,
  senderHandle,
  senderAvatarColors,
  balance,
  amount,
  className,
  style,
}: AmountSourceCardProps) {
  return (
    <div
      className={["zkm-amount-source", className].filter(Boolean).join(" ")}
      style={{ borderRadius: 12, ...style }}
    >
      <div className="zkm-amount-source__header">
        <span className="zkm-amount-source__label">From:</span>
        <span className="zkm-amount-source__balance">
          <span>Balance:</span>
          <span>{formatBalance(balance)}</span>
        </span>
      </div>
      <div className="zkm-amount-source__row">
        <GradientInitialAvatar name={senderName} colors={senderAvatarColors ?? DEFAULT_AVATAR_COLORS} size={40} />
        <span className="zkm-amount-source__id">
          <span className="zkm-amount-source__name">{senderName}</span>
          <span className="zkm-amount-source__handle">{senderHandle}</span>
        </span>
        <span className="zkm-row-spacer" />
        <span className="zkm-amount-source__amount">{amount}</span>
      </div>
    </div>
  )
}

export interface TransferAmountPerson {
  name: string
  handle: string
  /** Avatar gradient pair. Default brand purple→cyan. */
  colors?: readonly [string, string]
}

const CORNERS: Record<NonNullable<TransferAmountCardProps["cornerStyle"]>, string> = {
  all: "12px",
  top: "12px 12px 4px 4px",
  bottom: "4px 4px 12px 12px",
}

export interface TransferAmountCardProps {
  /** Header label, e.g. "From:" or "To:". */
  roleLabel: string
  person: TransferAmountPerson
  /** Formatted balance, e.g. "$120.50". Default "$0". */
  balanceText?: string
  /** Swaps the balance value for a small spinner. */
  balanceLoading?: boolean
  /** Amount text color. Default primary text. */
  amountColor?: string
  /** Small caption under the amount (e.g. a fiat conversion). */
  amountCaption?: string
  /** "top"/"bottom" flatten the facing corners so two cards stack with a 4px seam. */
  cornerStyle?: "top" | "bottom" | "all"
  /** Amount view at the trailing edge (text, input, or formatted node). */
  amount: ReactNode
  className?: string
  style?: CSSProperties
}

/**
 * Stacked From/To variant of AmountSourceCard: role label header, person row,
 * amount + optional caption at the trailing edge. Stack a "top" and "bottom"
 * card for two-party transfer entry.
 */
export function TransferAmountCard({
  roleLabel,
  person,
  balanceText,
  balanceLoading = false,
  amountColor,
  amountCaption,
  cornerStyle = "all",
  amount,
  className,
  style,
}: TransferAmountCardProps) {
  return (
    <div
      className={["zkm-amount-source", className].filter(Boolean).join(" ")}
      style={{ borderRadius: CORNERS[cornerStyle], ...style }}
    >
      <div className="zkm-amount-source__header">
        <span className="zkm-amount-source__label">{roleLabel}</span>
        <span className="zkm-amount-source__balance">
          <span>Balance:</span>
          {balanceLoading ? <Spinner size={10} /> : <span>{balanceText ?? "$0"}</span>}
        </span>
      </div>
      <div className="zkm-amount-source__row">
        <GradientInitialAvatar name={person.name} colors={person.colors ?? DEFAULT_AVATAR_COLORS} size={40} />
        <span className="zkm-amount-source__id">
          <span className="zkm-amount-source__name">{person.name}</span>
          <span className="zkm-amount-source__handle">{person.handle}</span>
        </span>
        <span className="zkm-row-spacer" />
        <span className="zkm-amount-source__trailing">
          <span className="zkm-amount-source__amount" style={amountColor ? { color: amountColor } : undefined}>
            {amount}
          </span>
          {amountCaption && <span className="zkm-amount-source__caption">{amountCaption}</span>}
        </span>
      </div>
    </div>
  )
}
