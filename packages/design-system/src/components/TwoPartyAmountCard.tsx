import type { ReactNode } from "react"
import { GradientInitialAvatar } from "./Avatars"
import { LiquidGlassPill } from "./LiquidGlassPill"

export type TwoPartyRole = "youSend" | "receive" | "send" | "youRequest"

const ROLE_CHIP: Record<TwoPartyRole, { label: string; icon: string }> = {
  youSend: { label: "You send", icon: "arrowshape-right" },
  receive: { label: "Receive", icon: "arrowshape-left" },
  send: { label: "Send", icon: "arrowshape-right" },
  youRequest: { label: "You request", icon: "arrowshape-left" },
}

export interface TwoPartyPerson {
  name: string
  handle: string
  colors?: readonly [string, string]
  ringed?: boolean
}

export interface TwoPartyAmountCardProps {
  role: TwoPartyRole
  person: TwoPartyPerson
  /** Available balance; omit to hide the row. */
  balance?: number
  /** "top"/"bottom" flatten the facing corners so two cards stack with a 4px seam. */
  cornerStyle?: "top" | "bottom" | "all"
  /** Amount view at the trailing edge (text, input, or formatted node). */
  amount: ReactNode
  className?: string
}

const CORNERS: Record<NonNullable<TwoPartyAmountCardProps["cornerStyle"]>, string> = {
  top: "12px 12px 4px 4px",
  bottom: "4px 4px 12px 12px",
  all: "12px",
}

/**
 * Amount-entry card for send/request flows: role chip + optional balance on
 * top, person + amount below. Stack a "top" and "bottom" card with 4px gap
 * for two-party entry.
 */
export function TwoPartyAmountCard({ role, person, balance, cornerStyle = "all", amount, className }: TwoPartyAmountCardProps) {
  const chip = ROLE_CHIP[role]
  return (
    <div
      className={["zkm-two-party-card", className].filter(Boolean).join(" ")}
      style={{ borderRadius: CORNERS[cornerStyle] }}
    >
      <div className="zkm-two-party-card__chip-row">
        <LiquidGlassPill label={chip.label} icon={chip.icon} labelTracking={-0.11} shadowRadius={10.9} />
        {balance !== undefined && (
          <span className="zkm-two-party-card__balance">
            Balance:{" "}
            <span>
              {Number.isInteger(balance) ? `$${balance}` : `$${balance.toFixed(2)}`}
            </span>
          </span>
        )}
      </div>
      <div className="zkm-two-party-card__person">
        <GradientInitialAvatar name={person.name} colors={person.colors} size={32} ringed={person.ringed} />
        <span className="zkm-two-party-card__id">
          <span className="zkm-two-party-card__name">{person.name}</span>
          <span className="zkm-two-party-card__handle">{person.handle}</span>
        </span>
        <span className="zkm-row-spacer" />
        <span className="zkm-two-party-card__amount">{amount}</span>
      </div>
    </div>
  )
}
