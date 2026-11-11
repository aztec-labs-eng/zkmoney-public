import { useRef, useState, type ReactNode } from "react"
import { ComingSoonPill, Icon } from "@obsidion/web-ds"
import { fmt } from "../../lib/fmt"
import copy from "./PickerList.copy"
import styles from "./PickerList.module.css"

export interface PickerItem {
  id: string
  icon: ReactNode
  title: string
  /** A ticker beside the title. */
  tag?: string
  /** One detail line: the chain and contract, or how long it takes. */
  detail?: string
  comingSoon?: boolean
  /** Replaces the row's `picker-{id}` test id. */
  testId?: string
}

/** One searchable list for every chain or token pick; the chosen row carries the check. */
export function PickerList({
  items,
  selected,
  onPick,
  searchLabel,
  section,
  inPane = false,
}: {
  items: readonly PickerItem[]
  selected?: string
  onPick: (id: string) => void
  /** Unset, the list has no search box. */
  searchLabel?: string
  /** A label over the rows; a function gets the count of rows the search leaves. */
  section?: string | ((shown: number) => string)
  /** Sits in a flow's pane. */
  inPane?: boolean
}) {
  const [query, setQuery] = useState("")
  const input = useRef<HTMLInputElement>(null)
  // Rows fade in when the options change; the first ones arrive with the list.
  const ids = items.map((item) => item.id).join("\n")
  const [shownIds, setShownIds] = useState(ids)
  const [swaps, setSwaps] = useState(0)
  if (ids !== shownIds) {
    setShownIds(ids)
    setSwaps(swaps + 1)
  }
  const rowClass = `zkm-btn-reset ${styles.row}${swaps ? ` ${styles.rowIn}` : ""}`
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? items.filter((item) => `${item.title} ${item.tag ?? ""}`.toLowerCase().includes(needle))
    : items
  const heading = typeof section === "function" ? section(shown.length) : section
  return (
    <div className={inPane ? `${styles.list} ${styles.pane}` : styles.list}>
      {searchLabel && (
        <label className={styles.search}>
          <Icon name="search" size={18} />
          <input
            type="search"
            placeholder={searchLabel}
            aria-label={searchLabel}
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              className={`zkm-btn-reset ${styles.clear}`}
              aria-label={copy.clear}
              onClick={() => {
                setQuery("")
                input.current?.focus()
              }}
            >
              <Icon name="x" size={12} strokeWidth={2.2} />
            </button>
          )}
        </label>
      )}
      {needle && shown.length === 0 ? (
        <p className={styles.empty} role="status">
          {fmt(copy.noResults, { query: query.trim() })}
        </p>
      ) : (
        <div className={styles.rows} role="listbox" aria-label={heading ?? searchLabel}>
          {heading && <span className={styles.section}>{heading}</span>}
          {shown.map((item) => (
            <button
              key={`${swaps}:${item.id}`}
              type="button"
              role="option"
              className={rowClass}
              data-testid={item.testId ?? `picker-${item.id}`}
              aria-selected={item.id === selected}
              disabled={item.comingSoon}
              onClick={() => onPick(item.id)}
            >
              {item.icon}
              <span className={styles.text}>
                <b>
                  {item.title}
                  {item.tag && <small>{item.tag}</small>}
                </b>
                {item.detail && <small>{item.detail}</small>}
              </span>
              {item.comingSoon ? (
                <ComingSoonPill />
              ) : (
                item.id === selected && (
                  <span className={styles.check}>
                    <Icon name="check" size={12} color="#212121" />
                  </span>
                )
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
