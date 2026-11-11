import type { ReactNode } from "react"
import { PUBLIC_TX_LIMIT_USD } from "@obsidion/core/constants"
import { Icon } from "@obsidion/web-ds"
import { groupedCents } from "../../ui/groupedCents"
import { InfoButton } from "../../ui/InfoButton/InfoButton"
import { maximumNow, OVER_LIMIT, SHEET_TITLE } from "./limitsCopy"
import "./aboutLimits.css"

/** `$2,499.65` / `$2,500` / `<$0.01`: dollars with thousands separators, so an amount and the limit
 *  it is checked against read alike in the deposit and withdrawal sheets. */
export function usdFigureGrouped(display: string): string {
  const grouped = groupedCents(display)
  if (grouped === undefined) return display
  return grouped.startsWith("<") ? `<$${grouped.slice(1)}` : `$${grouped}`
}

/** `$5,000`: the published per-operation limit. */
export function formatPublicLimit(): string {
  return usdFigureGrouped(String(PUBLIC_TX_LIMIT_USD))
}

export const DEPOSIT_LIMIT_BASIS = "sent, including fees"

/** Names the valuation the limit is checked with, so no `$` figure reads as a market price. */
export function nominalValuationNote(symbol: string): string {
  return `The limit counts 1 ${symbol} as $1. This is a fixed rate, not a market price.`
}

type Operation = "deposit" | "withdrawal" | "move"

/**
 * The limit in the words of the amount it counts. A fresh-address withdrawal is two burns, each its
 * own withdrawal under the limit.
 */
export const LIMIT_LINE: Record<"address" | "eachWithdrawal", string> = {
  eachWithdrawal: `Max per withdrawal: ${formatPublicLimit()} incl. fees`,
  address: `Deposit limit: ${formatPublicLimit()} incl. fees`,
}

/** One compact limit row. `info` is the button that opens the explanation. */
export function LimitLine({
  kind,
  info,
  testId = "limit-line",
}: {
  kind: keyof typeof LIMIT_LINE
  info?: ReactNode
  testId?: string
}) {
  return (
    <div className="ww-limit-line" data-testid={testId}>
      <span>{LIMIT_LINE[kind]}</span>
      {info}
    </div>
  )
}

export type LimitProblem = "public" | "protocol" | "valuation"

/** Why an amount cannot go, next to the field, with the one correction the wallet can offer. */
export function LimitNotice({
  operation,
  problem,
  maximum,
  onUseMaximum,
  onAboutLimits,
}: {
  operation: Operation
  problem: LimitProblem
  /** Display figure of the largest amount that passes; never the protocol ceiling itself. */
  maximum?: string
  onUseMaximum?: () => void
  onAboutLimits?: () => void
}) {
  if (problem === "valuation")
    return (
      <LimitReason
        reason={`This token can't be checked against the ${formatPublicLimit()} limit, so it can't be sent from here.`}
      />
    )
  const reason = maximum
    ? maximumNow(OPERATION_VERB[operation], maximum)
    : problem === "public"
    ? `Over the ${formatPublicLimit()} limit`
    : `Over the network's maximum per ${operation}`
  return (
    <LimitReason
      title={OVER_LIMIT}
      reason={reason}
      onAboutLimits={onAboutLimits}
      action={onUseMaximum && { label: "Use maximum", onSelect: onUseMaximum }}
    />
  )
}

const OPERATION_VERB: Record<Operation, string> = {
  deposit: "deposit",
  withdrawal: "withdraw",
  move: "move",
}

/** One blocking reason, with the action that resolves it when there is one. */
export function LimitReason({
  title,
  reason,
  onAboutLimits,
  action,
}: {
  title?: string
  reason: string
  /** Opens the About limits sheet from an info icon after the title. */
  onAboutLimits?: () => void
  action?: { label: string; onSelect: () => void }
}) {
  return (
    <div className="ww-limit-notice" role="alert" data-testid="limit-notice">
      <Icon name="alert-triangle" size={16} className="ww-limit-notice__icon" />
      <div className="ww-limit-notice__text">
        {title && (
          <p className="ww-limit-notice__title">
            {title}
            {onAboutLimits && (
              <InfoButton
                label={SHEET_TITLE}
                testId="limit-notice-about"
                outline
                onClick={onAboutLimits}
              />
            )}
          </p>
        )}
        <p className="ww-limit-notice__body">{reason}</p>
      </div>
      {action && (
        <button
          type="button"
          className="zkm-btn-reset ww-deposit-sheet__check ww-limit-notice__action"
          data-testid="limit-notice-use-maximum"
          onClick={action.onSelect}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
