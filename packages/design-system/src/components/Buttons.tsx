import type { CSSProperties } from "react"
import { Glass } from "@samasante/liquid-glass"
import { Icon } from "./Icon"

export interface PrimaryGradientButtonProps {
  title: string
  /** "gradient" = brand purple→cyan primary; "dark" = liquid-glass secondary; "danger" = pink capsule. */
  buttonStyle?: "gradient" | "dark" | "danger"
  /** Leading icon name (e.g. "share", "file-copy"). */
  leadingIcon?: string
  /** Trailing icon name (e.g. "arrow-right"). */
  trailingIcon?: string
  isLoading?: boolean
  isDisabled?: boolean
  onClick?: () => void
  className?: string
  style?: CSSProperties
  /** Stable hook for the e2e. Set it on CTAs that drive a flow, so a copy change is not a red suite. */
  testId?: string
}

/** Optics for the "dark" secondary capsule. Chrome/Edge bend the live backdrop
 *  (backdrop-filter: url); Safari/Firefox get frost + tint + edge light from the
 *  same component. */
const DARK_GLASS_OPTICS = {
  strength: 0.05,
  bend: 0.45,
  curvature: 0.3,
  dispersion: 0.32,
  frost: 6,
  sheen: 0.32,
  brightness: 0,
}

/** Full-width 56px capsule CTA. "gradient" = primary; "dark" = liquid-glass secondary; "danger" = destructive. */
export function PrimaryGradientButton({
  title,
  buttonStyle = "gradient",
  leadingIcon,
  trailingIcon,
  isLoading = false,
  isDisabled = false,
  onClick,
  className,
  style,
  testId,
}: PrimaryGradientButtonProps) {
  const disabled = isLoading || isDisabled
  const label = (
    <span className="zkm-primary-btn__label" style={isLoading ? { opacity: 0 } : undefined}>
      {leadingIcon && <Icon name={leadingIcon} size={24} />}
      {title}
      {trailingIcon && <Icon name={trailingIcon} size={18} />}
    </span>
  )
  if (buttonStyle === "dark") {
    return (
      <Glass
        role="button"
        data-testid={testId}
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled || undefined}
        className={[
          "zkm-btn-reset zkm-pressable zkm-primary-btn",
          disabled ? "zkm-primary-btn--disabled" : "",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        // Glass pins display:inline-block inline; restore the class's flex centering via the style prop.
        style={{ display: "flex", background: "rgba(16, 16, 20, 0.35)", ...style }}
        optics={DARK_GLASS_OPTICS}
        onClick={disabled ? undefined : onClick}
        onKeyDown={(e) => {
          if (disabled || (e.key !== "Enter" && e.key !== " ")) return
          e.preventDefault()
          onClick?.()
        }}
      >
        {label}
        {isLoading && <span className="zkm-spinner" aria-label="Loading" />}
      </Glass>
    )
  }
  return (
    <button
      type="button"
      data-testid={testId}
      className={[
        "zkm-btn-reset zkm-pressable zkm-primary-btn",
        buttonStyle === "danger" ? "zkm-primary-btn--danger" : "zkm-primary-btn--gradient",
        disabled ? "zkm-primary-btn--disabled" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      disabled={disabled}
      onClick={onClick}
      style={style}
    >
      {label}
      {isLoading && <span className="zkm-spinner" aria-label="Loading" />}
    </button>
  )
}

export interface DestructiveActionButtonProps {
  title: string
  /** Trailing icon. Default "trash". */
  icon?: string
  onClick?: () => void
  className?: string
}

/** Full-width destructive action row — pink label + trailing icon on translucent pink surface. */
export function DestructiveActionButton({
  title,
  icon = "trash",
  onClick,
  className,
}: DestructiveActionButtonProps) {
  return (
    <button
      type="button"
      className={["zkm-btn-reset zkm-pressable zkm-destructive-btn", className]
        .filter(Boolean)
        .join(" ")}
      onClick={onClick}
    >
      <span>{title}</span>
      <Icon name={icon} size={16} />
    </button>
  )
}

export interface GradientToggleProps {
  isOn: boolean
  onChange?: (on: boolean) => void
  className?: string
}

/** Pill on/off toggle — brand-gradient track when on. 64x28 track, 24px knob. */
export function GradientToggle({ isOn, onChange, className }: GradientToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isOn}
      className={["zkm-btn-reset zkm-toggle", isOn ? "zkm-toggle--on" : "", className]
        .filter(Boolean)
        .join(" ")}
      onClick={() => onChange?.(!isOn)}
    >
      <span className="zkm-toggle__knob" />
    </button>
  )
}

export interface HomeQuickAction {
  title: string
  /** Icon name (canonical or SF Symbol alias). */
  icon: string
  /** Grayed out and inert — for actions not yet available. */
  disabled?: boolean
  onClick?: () => void
}

export interface HomeQuickActionsRowProps {
  actions: HomeQuickAction[]
  className?: string
}

/** Home-screen quick-action tiles: icon tile + caption below, equal widths. */
export function HomeQuickActionsRow({ actions, className }: HomeQuickActionsRowProps) {
  return (
    <div className={["zkm-quick-actions", className].filter(Boolean).join(" ")}>
      {actions.map((a) => (
        <button
          key={a.title}
          type="button"
          disabled={a.disabled}
          className={[
            "zkm-btn-reset zkm-quick-action",
            a.disabled ? "zkm-quick-action--disabled" : "zkm-pressable",
          ].join(" ")}
          onClick={a.disabled ? undefined : a.onClick}
        >
          <span className="zkm-quick-action__tile">
            <Icon
              name={a.icon}
              size={26}
              color={a.disabled ? "rgba(255,255,255,0.35)" : "var(--text-secondary)"}
            />
          </span>
          <span className="zkm-quick-action__caption">{a.title}</span>
        </button>
      ))}
    </div>
  )
}

export interface AmountChipRowProps {
  /** Quick-fill dollar values, e.g. [10, 25, 50, 100]. */
  values: number[]
  /** Liquid-glass capsule (default) vs flat fill for non-aurora surfaces. */
  glass?: boolean
  /** Highlighted chip (controlled; brand-gradient fill). */
  selectedValue?: number
  /** Chips shown but not selectable, e.g. amounts under a live minimum. */
  disabledValues?: number[]
  onSelect?: (value: number) => void
  className?: string
}

/** Row of quick-fill amount chips ("$10" "$25" …) on the send-amount screen. */
export function AmountChipRow({
  values,
  glass = true,
  selectedValue,
  disabledValues = [],
  onSelect,
  className,
}: AmountChipRowProps) {
  return (
    <div className={["zkm-amount-chips", className].filter(Boolean).join(" ")}>
      {values.map((v) => {
        const disabled = disabledValues.includes(v)
        return (
          <button
            key={v}
            type="button"
            className={[
              "zkm-btn-reset zkm-amount-chip",
              disabled ? "zkm-amount-chip--disabled" : "zkm-pressable",
              glass ? "zkm-amount-chip--glass" : "zkm-amount-chip--flat",
              v === selectedValue ? "zkm-amount-chip--selected" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-pressed={v === selectedValue || undefined}
            aria-disabled={disabled || undefined}
            onClick={disabled ? undefined : () => onSelect?.(v)}
          >
            ${v}
          </button>
        )
      })}
    </div>
  )
}
