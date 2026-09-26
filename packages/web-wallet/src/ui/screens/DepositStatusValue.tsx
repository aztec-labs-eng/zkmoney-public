import { Icon, Spinner, type StatusBadgeStyle } from "@obsidion/web-ds"

export function DepositStatusValue({ label, badge }: { label: string; badge: StatusBadgeStyle }) {
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
