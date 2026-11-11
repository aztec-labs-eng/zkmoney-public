import type { ReactNode } from "react"
import { PrimaryGradientButton } from "./Buttons"
import { Icon } from "./Icon"

export interface SheetAction {
  label: string
  onClick: () => void
  disabled?: boolean
  loading?: boolean
  /** Stable hook for the e2e, so a copy change is not a red suite. */
  testId?: string
}

/** key = a step of a flow; warning = a wait or a fix; error = a failure; success = done. */
export type SheetHero = "key" | "warning" | "error" | "success"

export interface SheetShellProps {
  hero: SheetHero
  title: string
  lead?: ReactNode
  /** Boxes under the lead, stacked 12px apart. */
  children?: ReactNode
  /** "plain" is the gray capsule for a sheet whose only way on is to close it. */
  primary?: SheetAction & { style?: "gradient" | "plain" }
  /** Text button under the primary. */
  secondary?: SheetAction
}

function SheetHeroMark({ hero }: { hero: SheetHero }) {
  switch (hero) {
    case "key":
      return (
        <span className="zkm-sheet-shell__key" aria-hidden>
          <Icon name="key-fill" size={32} color="#fff" />
        </span>
      )
    case "warning":
      return <Icon name="alert-fill" size={40} color="var(--accent-warning)" />
    case "error":
      return <Icon name="x-mark" size={48} color="var(--accent-pink)" />
    case "success":
      return <Icon name="check-micro" size={48} color="var(--accent-green)" />
  }
}

/**
 * Body of a guided-flow sheet: hero mark, title, lead, boxes, actions. Transparent: the host dialog
 * draws the card and the close button, and on phones docks it as the bottom sheet.
 */
export function SheetShell({ hero, title, lead, children, primary, secondary }: SheetShellProps) {
  return (
    <div className="zkm-sheet-shell">
      <div className="zkm-sheet-shell__head">
        <SheetHeroMark hero={hero} />
        <div className="zkm-sheet-shell__titles">
          <h2 className="zkm-gradient-text zkm-gradient-text--title zkm-sheet-shell__title">
            {title}
          </h2>
          {lead && <div className="zkm-sheet-shell__lead">{lead}</div>}
        </div>
      </div>
      {children && <div className="zkm-sheet-shell__body">{children}</div>}
      {primary && (
        <PrimaryGradientButton
          title={primary.label}
          buttonStyle={primary.style}
          isDisabled={primary.disabled}
          isLoading={primary.loading}
          onClick={primary.onClick}
          testId={primary.testId}
        />
      )}
      {secondary && (
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable zkm-sheet-shell__secondary"
          disabled={secondary.disabled || secondary.loading}
          onClick={secondary.onClick}
          data-testid={secondary.testId}
        >
          {secondary.label}
        </button>
      )}
    </div>
  )
}

export interface SheetCardProps {
  /** Caption above the box, e.g. "On this account". */
  label?: string
  children: ReactNode
}

/** Bordered box that groups rows on a sheet. */
export function SheetCard({ label, children }: SheetCardProps) {
  const box = <div className="zkm-sheet-card">{children}</div>
  if (!label) return box
  return (
    <section className="zkm-sheet-card-group">
      <h3 className="zkm-sheet-card-group__label">{label}</h3>
      {box}
    </section>
  )
}

export interface SheetLinkProps {
  label: string
  /** Opens in a new tab, so the flow underneath survives. */
  href?: string
  onClick?: () => void
}

/** Underlined text link on a sheet. */
export function SheetLink({ label, href, onClick }: SheetLinkProps) {
  if (href) {
    return (
      <a className="zkm-sheet-link" href={href} target="_blank" rel="noreferrer" onClick={onClick}>
        {label}
      </a>
    )
  }
  return (
    <button type="button" className="zkm-btn-reset zkm-sheet-link" onClick={onClick}>
      {label}
    </button>
  )
}
