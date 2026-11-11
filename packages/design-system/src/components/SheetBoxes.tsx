import type { ReactNode } from "react"
import { useEffect, useId, useRef, useState } from "react"
import { Icon } from "./Icon"

export interface FactHint {
  /** Accessible name of the info button. */
  label: string
  title: string
  rows: { label: string; value: string }[]
  note?: string
}

export interface Fact {
  label: string
  value: ReactNode
  /** Breakdown behind an info icon beside the label. */
  hint?: FactHint
}

export interface FactBoxProps {
  facts: Fact[]
}

/**
 * Opens on mouse hover, and stays open after a tap, click or Enter until a press or focus lands
 * elsewhere.
 */
function FactHintButton({ hint }: { hint: FactHint }) {
  const [hovered, setHovered] = useState(false)
  const [pinned, setPinned] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  const unhover = useRef<ReturnType<typeof setTimeout>>(undefined)
  const tip = useId()
  const open = hovered || pinned

  useEffect(() => () => clearTimeout(unhover.current), [])

  useEffect(() => {
    if (!open) return
    const unpin = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setPinned(false)
    }
    // Captured, so wherever focus is, Escape closes only the tip and never the dialog around it.
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.preventDefault()
      e.stopPropagation()
      setHovered(false)
      setPinned(false)
    }
    // Focus landing outside the hint closes it, even under a resting mouse, so the tip never
    // covers what has focus. A press on the tip can move focus to the dialog card around it, so
    // the card doesn't count; presses outside are the pointerdown listener's.
    let focused = document.activeElement
    const closeOnFocusAway = (e: FocusEvent) => {
      // Coming back to the window fires focusin again on the element that already had focus.
      if (e.target === focused) return
      focused = e.target as Element
      if (!root.current?.contains(focused) && !focused.contains(root.current)) {
        setHovered(false)
        setPinned(false)
      }
    }
    document.addEventListener("pointerdown", unpin)
    document.addEventListener("keydown", closeOnEscape, true)
    document.addEventListener("focusin", closeOnFocusAway)
    return () => {
      document.removeEventListener("pointerdown", unpin)
      document.removeEventListener("keydown", closeOnEscape, true)
      document.removeEventListener("focusin", closeOnFocusAway)
    }
  }, [open])

  return (
    <span
      ref={root}
      className="zkm-fact-hint"
      onPointerEnter={(e) => {
        if (e.pointerType !== "mouse") return
        clearTimeout(unhover.current)
        setHovered(true)
      }}
      // A short grace, so the pointer can cross the gap to the tip on any path.
      onPointerLeave={(e) => {
        if (e.pointerType !== "mouse") return
        unhover.current = setTimeout(() => setHovered(false), 150)
      }}
    >
      <button
        type="button"
        className="zkm-btn-reset zkm-fact-hint__button"
        aria-label={hint.label}
        aria-expanded={open}
        aria-controls={tip}
        aria-describedby={tip}
        onClick={() => setPinned((p) => !p)}
      >
        <Icon name="information-line" size={12} />
      </button>
      <span
        id={tip}
        role="tooltip"
        className="zkm-fact-hint__tip"
        // Stays mounted while closed, so screen readers read it as the button's description.
        hidden={!open}
      >
        <span className="zkm-fact-hint__title">{hint.title}</span>
        {hint.rows.map((row, i) => (
          <span key={i} className="zkm-fact-hint__row">
            <span className="zkm-fact-hint__row-label">{row.label}</span>
            <span>{row.value}</span>
          </span>
        ))}
        {hint.note && <span>{hint.note}</span>}
      </span>
    </span>
  )
}

/** Label and value lines in a bordered box: cost, time, what was charged. */
export function FactBox({ facts }: FactBoxProps) {
  return (
    <dl className="zkm-sheet-card zkm-fact-box">
      {facts.map((fact, i) => (
        <div key={i} className="zkm-fact-box__row">
          <dt className="zkm-fact-box__label">
            {fact.label}
            {fact.hint && <FactHintButton hint={fact.hint} />}
          </dt>
          <dd className="zkm-fact-box__value">{fact.value}</dd>
        </div>
      ))}
    </dl>
  )
}

export interface InfoBoxProps {
  title: string
  children: ReactNode
}

/** Calm blue-gray note: something to know, not something wrong. */
export function InfoBox({ title, children }: InfoBoxProps) {
  return (
    <div className="zkm-info-box" role="note">
      <Icon name="information-fill" size={16} className="zkm-info-box__icon" />
      <div className="zkm-info-box__text">
        <div className="zkm-info-box__title">{title}</div>
        <div className="zkm-info-box__body">{children}</div>
      </div>
    </div>
  )
}

export interface ChoiceCardProps {
  /** Radio group name; cards sharing it form one choice. */
  name: string
  value: string
  checked: boolean
  onChange: (value: string) => void
  label: string
  description?: string
  /** Pill after the label, e.g. "Recommended". */
  badge?: string
  disabled?: boolean
}

/** One option of a single choice, as a card with a radio. */
export function ChoiceCard({
  name,
  value,
  checked,
  onChange,
  label,
  description,
  badge,
  disabled,
}: ChoiceCardProps) {
  return (
    <label
      className={[
        "zkm-choice-card",
        checked && "zkm-choice-card--checked",
        disabled && "zkm-choice-card--disabled",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <input
        type="radio"
        className="zkm-choice-card__input"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onChange(value)}
      />
      <span className="zkm-choice-card__radio" aria-hidden />
      <span className="zkm-choice-card__text">
        <span className="zkm-choice-card__title-row">
          <span className="zkm-choice-card__label">{label}</span>
          {badge && <span className="zkm-choice-card__badge">{badge}</span>}
        </span>
        {description && <span className="zkm-choice-card__description">{description}</span>}
      </span>
    </label>
  )
}
