import type { CSSProperties, ReactNode } from "react"
import { useId } from "react"

export interface TextFieldProps {
  value: string
  onChange: (value: string) => void
  label?: string
  placeholder?: string
  /** HTML input type. Default "text". */
  type?: string
  inputMode?: "text" | "email" | "decimal" | "numeric" | "search" | "tel" | "url"
  autoFocus?: boolean
  disabled?: boolean
  /** Message under the field; also paints the error ring. */
  error?: string
  /** Trailing slot inside the field box (e.g. a paste chip). */
  trailing?: ReactNode
  /** Called on Enter. */
  onSubmit?: () => void
  className?: string
  style?: CSSProperties
}

/** Labeled single-line text input on the translucent dark field surface. */
export function TextField({
  value,
  onChange,
  label,
  placeholder,
  type = "text",
  inputMode,
  autoFocus = false,
  disabled = false,
  error,
  trailing,
  onSubmit,
  className,
  style,
}: TextFieldProps) {
  const id = useId()
  return (
    <div
      className={["zkm-field", error ? "zkm-field--error" : "", className].filter(Boolean).join(" ")}
      style={style}
    >
      {label && (
        <label className="zkm-field__label" htmlFor={id}>
          {label}
        </label>
      )}
      <div className="zkm-field__box">
        <input
          id={id}
          className="zkm-field__input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          type={type}
          inputMode={inputMode}
          autoFocus={autoFocus}
          disabled={disabled}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit?.()
          }}
        />
        {trailing}
      </div>
      {error && <span className="zkm-field__error">{error}</span>}
    </div>
  )
}
