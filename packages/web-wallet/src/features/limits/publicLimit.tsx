import type { ReactNode } from "react"
import { PUBLIC_TX_LIMIT_USD } from "@obsidion/core/constants"
import { Icon } from "@obsidion/web-ds"
import "./aboutLimits.css"

/** `$2,499.65` / `$2,500` / `<$0.01`: dollars with thousands separators, so an amount and the limit
 *  it is checked against read alike in the deposit and withdrawal sheets. */
export function usdFigureGrouped(display: string): string {
  const n = Number(display)
  if (!Number.isFinite(n)) return display
  if (n > 0 && n < 0.005) return "<$0.01"
  const grouped = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `$${grouped}`.replace(/\.00$/, "")
}

/** `$2,500`: the published per-operation limit. */
export function formatPublicLimit(): string {
  return usdFigureGrouped(String(PUBLIC_TX_LIMIT_USD))
}

export const DEPOSIT_LIMIT_BASIS = "sent, including fees"

/** Names the valuation the limit is checked with, so no `$` figure reads as a market price. */
export function nominalValuationNote(symbol: string): string {
  return `The limit counts 1 ${symbol} as $1. This is a fixed rate, not a market price.`
}

type Operation = "deposit" | "withdrawal"

/**
 * The limit in the words of the amount it counts: a deposit's send, a withdrawal's debit. A
 * fresh-address withdrawal is two burns, each its own withdrawal under the limit.
 */
export const LIMIT_LINE: Record<Operation | "address" | "eachWithdrawal", string> = {
  deposit: `Max sent: ${formatPublicLimit()} incl. fees`,
  withdrawal: `Max from balance: ${formatPublicLimit()} incl. fees`,
  eachWithdrawal: `Max per withdrawal: ${formatPublicLimit()} incl. fees`,
  address: `Deposit limit: ${formatPublicLimit()} incl. fees`,
}

/** One compact limit row. `info` is the button that opens the explanation. */
export function LimitLine({
  kind,
  minimum,
  info,
  testId = "limit-line",
}: {
  kind: keyof typeof LIMIT_LINE
  /** Display figure of the smallest amount accepted. */
  minimum?: string
  info?: ReactNode
  testId?: string
}) {
  return (
    <div className="ww-limit-line" data-testid={testId}>
      <span>
        {minimum && `Min ${minimum} · `}
        {LIMIT_LINE[kind]}
      </span>
      {info}
    </div>
  )
}

/** Minimum and maximum beside an amount field. */
export function OperationLimits({
  operation,
  minimum,
  info,
}: {
  operation: Operation
  minimum: string
  info?: ReactNode
}) {
  return <LimitLine kind={operation} minimum={minimum} info={info} testId="operation-limits" />
}

export type LimitProblem = "public" | "protocol" | "valuation"

/** Why an amount cannot go, next to the field, with the one correction the wallet can offer. */
export function LimitNotice({
  operation,
  problem,
  maximum,
  onUseMaximum,
}: {
  operation: Operation
  problem: LimitProblem
  /** Display figure of the largest amount that passes; never the protocol ceiling itself. */
  maximum?: string
  onUseMaximum?: () => void
}) {
  const reason =
    problem === "valuation"
      ? `This token can't be checked against the ${formatPublicLimit()} limit, so it can't be sent from here.`
      : problem === "public"
      ? `Over the ${formatPublicLimit()} limit`
      : `Over the network's maximum per ${operation}`
  const label = maximum ? `Use maximum (${maximum})` : "Use maximum"
  return <LimitReason reason={reason} action={onUseMaximum && { label, onSelect: onUseMaximum }} />
}

/** One blocking reason, with the action that resolves it when there is one. */
export function LimitReason({
  reason,
  action,
}: {
  reason: string
  action?: { label: string; onSelect: () => void }
}) {
  return (
    <div className="ww-limit-reason" role="alert" data-testid="limit-notice">
      <span className="ww-limit-reason__text">
        <Icon name="alert-triangle" size={14} />
        {reason}
      </span>
      {action && (
        <button
          type="button"
          className="zkm-btn-reset ww-limit-reason__action"
          onClick={action.onSelect}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
