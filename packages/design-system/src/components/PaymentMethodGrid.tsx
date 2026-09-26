import { Icon } from "./Icon"

export interface PaymentMethod {
  label: string
  icon: string
  disabled?: boolean
  onClick?: () => void
}

export interface PaymentMethodGridProps {
  methods: PaymentMethod[]
  /** Grid columns. Default 3. */
  columns?: number
  className?: string
}

/**
 * "New payment" method grid — rounded glass tiles (Send / Receive / Link /
 * Scan / Bank / Email / Card / Deposit / Withdraw) with captions.
 */
export function PaymentMethodGrid({ methods, columns = 3, className }: PaymentMethodGridProps) {
  return (
    <div
      className={["zkm-method-grid", className].filter(Boolean).join(" ")}
      style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
    >
      {methods.map((m) => (
        <button
          key={m.label}
          type="button"
          className={`zkm-btn-reset zkm-pressable zkm-method-tile${m.disabled ? " zkm-method-tile--disabled" : ""}`}
          onClick={m.onClick}
          disabled={m.disabled}
        >
          <span className="zkm-method-tile__icon">
            <Icon name={m.icon} size={20} />
          </span>
          <span className="zkm-method-tile__label">{m.label}</span>
        </button>
      ))}
    </div>
  )
}
