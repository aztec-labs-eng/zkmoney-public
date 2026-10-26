import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { Icon } from "@obsidion/web-ds"
import {
  aboutLimitsView,
  type AboutLimitsFacts,
  type AboutLimitsFormat,
  type LimitsRow,
  type LimitsSectionView,
  type LimitsTopic,
} from "./aboutLimitsView"
import { LIMITS_DOCS_URL } from "../../lib/links"
import * as copy from "./limitsCopy"
import "./aboutLimits.css"

/** Label and value rows in the sheet's style, for a caller's own detail. */
export function LimitsRows({ rows }: { rows: (LimitsRow & { testId?: string })[] }) {
  return (
    <dl className="ww-about-limits__rows">
      {rows.map((row) => (
        <div key={row.label} className="ww-about-limits__row">
          <dt>{row.label}</dt>
          <dd data-testid={row.testId}>{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function LimitsSection({
  testId,
  title,
  view,
  expanded,
  onToggle,
  detail,
  onRetry,
}: {
  testId: string
  title: string
  view: LimitsSectionView<string> & { canRetry?: boolean }
  expanded: boolean
  onToggle: () => void
  /** The calling surface's own lines for this section, shown first. */
  detail?: ReactNode
  onRetry?: () => void
}) {
  const headingId = useId()
  const bodyId = useId()
  const statusRef = useRef<HTMLParagraphElement>(null)
  const retried = useRef(false)
  const showRetry = !!view.canRetry && !!onRetry
  // A successful retry removes the focused button. Keep keyboard focus in the section, unless the
  // user already moved it elsewhere.
  useEffect(() => {
    if (showRetry || !retried.current) return
    retried.current = false
    const status = statusRef.current
    const active = document.activeElement
    if (status && (!active || active.contains(status))) status.focus()
  }, [showRetry])
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      data-state={view.state}
      data-expanded={expanded}
      className="ww-about-limits__section"
    >
      <h3 id={headingId} className="ww-about-limits__title">
        <button
          type="button"
          className="zkm-btn-reset ww-about-limits__toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          data-testid={`${testId}-toggle`}
          onClick={onToggle}
        >
          {title}
          <Icon name={expanded ? "chevron-up" : "chevron-down"} size={16} />
        </button>
      </h3>
      {view.status && (
        <p
          role="status"
          ref={statusRef}
          tabIndex={-1}
          data-testid={`${testId}-state`}
          className="ww-about-limits__status"
        >
          <span aria-hidden="true" className="ww-about-limits__icon">
            <Icon name={view.status.icon} size={16} />
          </span>
          {view.status.text}
        </p>
      )}
      {showRetry && (
        <button
          type="button"
          className="zkm-btn-reset ww-about-limits__retry"
          data-testid={`${testId}-retry`}
          onClick={() => {
            retried.current = true
            onRetry!()
          }}
        >
          {copy.CHECK_AGAIN}
        </button>
      )}
      <div id={bodyId} className="ww-about-limits__body" hidden={!expanded}>
        {detail}
        {view.rows.length > 0 && <LimitsRows rows={view.rows} />}
        {view.notes.map((note) => (
          <p key={note} className="ww-about-limits__note">
            {note}
          </p>
        ))}
      </div>
    </section>
  )
}

const ORDER: LimitsTopic[] = ["limit", "capacity", "sponsorship"]

/** A calling surface's own lines, by section. */
export type LimitsDetails = Partial<Record<LimitsTopic, ReactNode>>

/**
 * Body of the About limits sheet. Facts come from their owners; this only presents them. With a
 * `topic`, that section comes first and opens expanded; the others start collapsed. Without one, every
 * section is expanded. `details` adds the calling surface's own lines to a section.
 */
export function AboutLimitsContent({
  facts,
  topic,
  details,
  onRetryCapacity,
  onRetrySponsorship,
  format,
  showCapacity = true,
}: {
  facts: AboutLimitsFacts
  topic?: LimitsTopic
  details?: LimitsDetails
  onRetryCapacity?: () => void
  onRetrySponsorship?: () => void
  format?: AboutLimitsFormat
  /** False leaves the capacity section out. */
  showCapacity?: boolean
}) {
  const view = aboutLimitsView(facts, format)
  const [open, setOpen] = useState<ReadonlySet<LimitsTopic>>(() => new Set(topic ? [topic] : ORDER))
  const section = (key: LimitsTopic) => {
    const props = {
      expanded: open.has(key),
      onToggle: () =>
        setOpen((current) => {
          const next = new Set(current)
          if (!next.delete(key)) next.add(key)
          return next
        }),
      detail: details?.[key],
    }
    switch (key) {
      case "limit":
        return (
          <LimitsSection
            key={key}
            testId="about-limits-operation"
            title={copy.LIMIT_TITLE}
            view={view.operation}
            {...props}
          />
        )
      case "capacity":
        return (
          <LimitsSection
            key={key}
            testId="about-limits-capacity"
            title={copy.CAPACITY_TITLE}
            view={view.capacity}
            onRetry={onRetryCapacity}
            {...props}
          />
        )
      case "sponsorship":
        return (
          <LimitsSection
            key={key}
            testId="about-limits-sponsorship"
            title={copy.SPONSORSHIP_TITLE}
            view={view.sponsorship}
            onRetry={onRetrySponsorship}
            {...props}
          />
        )
    }
  }
  const shown = showCapacity ? ORDER : ORDER.filter((key) => key !== "capacity")
  const order = topic ? [topic, ...shown.filter((key) => key !== topic)] : shown
  return (
    <div className="ww-about-limits">
      {order.map(section)}
      <a
        className="ww-about-limits__more"
        href={LIMITS_DOCS_URL}
        target="_blank"
        rel="noreferrer"
        data-testid="about-limits-more"
      >
        {copy.MORE_INFO}
        <Icon name="link" size={14} />
      </a>
    </div>
  )
}
