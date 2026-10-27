import type { ReactNode } from "react"
import { Icon, Spinner, type StatusBadgeStyle } from "@obsidion/web-ds"

/** A status with the reason for it on a line beneath. */
export function StatusWithReason({ status, reason }: { status: ReactNode; reason?: string }) {
  if (!reason) return <>{status}</>
  return (
    <span className="ww-status-reason">
      {status}
      <small>{reason}</small>
    </span>
  )
}

export function DepositStatusValue({
  label,
  badge,
  reason,
}: {
  label: string
  badge: StatusBadgeStyle
  reason?: string
}) {
  return <StatusWithReason status={statusValue(label, badge)} reason={reason} />
}

function statusValue(label: string, badge: StatusBadgeStyle) {
  if (badge === "pending")
    return (
      <b data-tone="pending">
        <Spinner size={11} color="#eed04e" /> {label}
      </b>
    )
  if (badge === "failed")
    return (
      <b data-tone="failed">
        <Icon name="alert-circle" size={16} color="#fe708b" /> {label}
      </b>
    )
  if (badge === "cancelled") return <b>{label}</b>
  return (
    <b data-tone="done">
      <Icon name="check-circle" size={16} color="#56e79d" /> {label}
    </b>
  )
}
