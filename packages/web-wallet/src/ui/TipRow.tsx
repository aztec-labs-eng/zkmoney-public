import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import "./tipRow.css"

/**
 * A label whose tip opens above its row on a press; a second press, Escape, or a press or focus
 * elsewhere closes it. Never on hover: the pointer often rests here when the sheet appears.
 */
export function TipRow({
  mark,
  label,
  testId,
  className,
  children,
}: {
  mark: ReactNode
  label: string
  testId?: string
  className?: string
  children: ReactNode
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const row = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: Event) => {
      if (!row.current?.contains(event.target as Node)) setOpen(false)
    }
    // Capture: the sheet around the tip closes on an Escape that reaches it.
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      button.current?.focus()
    }
    document.addEventListener("pointerdown", closeOutside)
    document.addEventListener("keydown", closeOnEscape, true)
    return () => {
      document.removeEventListener("pointerdown", closeOutside)
      document.removeEventListener("keydown", closeOnEscape, true)
    }
  }, [open])
  return (
    <div
      ref={row}
      className={className ? `ww-tiprow ${className}` : "ww-tiprow"}
      data-testid={testId}
      data-open={open || undefined}
      onBlur={(event) => {
        // Focus moved to another control; text selected inside the tip moves it nowhere.
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false)
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className="zkm-btn-reset ww-tiprow__label"
        aria-describedby={id}
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        {mark}
        {label}
      </button>
      <div className="ww-tiprow__tip" role="tooltip" id={id}>
        {children}
      </div>
    </div>
  )
}
