import type { ReactNode } from "react"
import { RowChevron } from "./GlassCircle"
import { Icon } from "./Icon"

export interface RatePillProps {
  /** The rate as it reads, e.g. "3.8% APY". */
  label: string
  /** `sm` sits under a row's value; `xs`, dotless, beside a title. */
  size?: "md" | "sm" | "xs"
  /** Says what the rate is, on hover. */
  title?: string
}

/** A yearly rate on a green capsule, led by a dot. */
export function RatePill({ label, size = "md", title }: RatePillProps) {
  return (
    <span
      className={size === "md" ? "zkm-rate-pill" : `zkm-rate-pill zkm-rate-pill--${size}`}
      title={title}
    >
      {label}
    </span>
  )
}

export interface HoldingRowProps {
  /** The asset's coin, 40px. */
  icon: ReactNode
  /** The asset's symbol. */
  title: ReactNode
  /** Beside the title, such as a `ComingSoonPill` reading "New". */
  badge?: ReactNode
  /** What the holding earns, under the title. */
  subtitle?: ReactNode
  /** What the holding is worth. */
  value?: ReactNode
  /** Under the value, such as a `RatePill`. */
  rate?: ReactNode
  /** Makes the row a button that ends in a chevron. */
  onClick?: () => void
}

/** One holding in a list: its coin, name and yield on the left, its worth and rate on the right. */
export function HoldingRow({
  icon,
  title,
  badge,
  subtitle,
  value,
  rate,
  onClick,
}: HoldingRowProps) {
  const body = (
    <>
      <span className="zkm-holding-row__icon">{icon}</span>
      <span className="zkm-holding-row__text">
        <span className="zkm-holding-row__name">
          <span className="zkm-holding-row__title">{title}</span>
          {badge}
        </span>
        {subtitle !== undefined && <span className="zkm-holding-row__subtitle">{subtitle}</span>}
      </span>
      {(value !== undefined || rate !== undefined) && (
        <span className="zkm-holding-row__end">
          {value !== undefined && <span className="zkm-holding-row__value">{value}</span>}
          {rate}
        </span>
      )}
    </>
  )
  if (!onClick) return <div className="zkm-holding-row">{body}</div>
  return (
    <button
      type="button"
      className="zkm-btn-reset zkm-pressable zkm-holding-row zkm-holding-row--button"
      onClick={onClick}
    >
      {body}
      <RowChevron />
    </button>
  )
}

export interface HoldingSelectProps {
  /** The asset's coin, 40px. */
  icon: ReactNode
  /** The asset's symbol. */
  title: ReactNode
  /** Beside the title, such as a `RatePill size="xs"`. */
  rate?: ReactNode
  /** What the holding earns, under the title. */
  subtitle?: ReactNode
  /** Names the control that picks another holding. */
  changeLabel?: string
  /** Shows that control. */
  onChange?: () => void
}

/** The holding a flow moves through, in a ringed card, with a control to pick another. */
export function HoldingSelect({
  icon,
  title,
  rate,
  subtitle,
  changeLabel,
  onChange,
}: HoldingSelectProps) {
  return (
    <div className="zkm-holding-select">
      <span className="zkm-holding-row__icon">{icon}</span>
      <span className="zkm-holding-row__text">
        <span className="zkm-holding-row__name">
          <span className="zkm-holding-row__title">{title}</span>
          {rate}
        </span>
        {subtitle !== undefined && <span className="zkm-holding-row__subtitle">{subtitle}</span>}
      </span>
      {onChange && changeLabel && (
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable zkm-holding-select__change"
          onClick={onChange}
        >
          {changeLabel}
          <Icon name="chevron-down" size={14} />
        </button>
      )}
    </div>
  )
}
