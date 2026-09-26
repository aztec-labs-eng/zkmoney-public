import { useState } from "react"
import { formatDateLabel } from "@obsidion/front-core"
import { GradientText } from "@obsidion/web-ds"
import { ActivityListSkeleton } from "../Skeletons"
import { useActivityEntries, type ActivityEntry } from "./useActivityEntries"

const FILTERS = ["All", "Sent", "Received", "Pending"] as const
type Filter = (typeof FILTERS)[number]

function matches(entry: ActivityEntry, filter: Filter): boolean {
  if (filter === "Sent") return entry.direction === "out" && !entry.unpaidRequest
  if (filter === "Received") return entry.direction === "in" && !entry.unpaidRequest
  if (filter === "Pending") return entry.pending
  return true
}

/** Newest-first entries bucketed under their day label (Today / Yesterday / date). */
function groupByDay(entries: ActivityEntry[]): [string, ActivityEntry[]][] {
  const groups = new Map<string, ActivityEntry[]>()
  for (const entry of entries) {
    const label = formatDateLabel(entry.ts)
    groups.set(label, [...(groups.get(label) ?? []), entry])
  }
  return [...groups]
}

/** Activity panel: the unified feed with direction/pending filter chips, grouped by day. */
export function ActivityScreen() {
  const { entries, hydrated, detailModals } = useActivityEntries()
  const [filter, setFilter] = useState<Filter>("All")
  const visible = entries.filter((e) => matches(e, filter))

  return (
    <div className="ww-panel">
      <div className="ww-panel__head">
        <GradientText size={24} weight={700}>
          Activity
        </GradientText>
      </div>
      <div className="ww-panel__scroll">
        <div className="ww-chip-row" style={{ marginBottom: 0 }}>
          {FILTERS.map((f) => {
            const active = filter === f
            return (
              <button
                key={f}
                type="button"
                className="zkm-btn-reset zkm-pressable ww-activity__chip"
                data-active={active || undefined}
                onClick={() => setFilter(f)}
              >
                {f}
              </button>
            )
          })}
        </div>
        {!hydrated && <ActivityListSkeleton rows={5} />}
        {hydrated && visible.length > 0 && (
          <div className="ww-activity__list">
            {groupByDay(visible).map(([label, group]) => (
              <div key={label} className="ww-contacts__section">
                <span className="ww-contacts__label">{label}</span>
                <div className="ww-activity__group">{group.map((entry) => entry.node)}</div>
              </div>
            ))}
          </div>
        )}
        {hydrated && visible.length === 0 && (
          <div className="ww-empty">
            <span>
              {entries.length === 0
                ? "Nothing here yet. Transactions will show up as soon as you make your first one."
                : `No ${filter.toLowerCase()} transactions yet.`}
            </span>
          </div>
        )}
      </div>
      {detailModals}
    </div>
  )
}
