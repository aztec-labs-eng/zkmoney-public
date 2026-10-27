import { useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { activityCsv, activityCsvFileName, formatDateLabel, savingsCsv } from "@obsidion/front-core"
import { GradientText, Icon } from "@obsidion/web-ds"
import { NonContactRequestsEntry } from "../../features/requests/NonContactRequestsScreen"
import { RequestsUnavailableNotice } from "../../features/requests/RequestsUnavailableNotice"
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

function downloadCsv(csv: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }))
  const link = document.createElement("a")
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

/**
 * Activity panel: the unified feed with direction/pending filter chips, grouped by day. With
 * `?account=savings` it is the Savings account's feed and export, as Savings' Home shows it.
 */
export function ActivityScreen() {
  const activity = useActivityEntries()
  const navigate = useNavigate()
  const savings = useSearchParams()[0].get("account") === "savings"
  const { requestsUnavailable, detailModals, csvSources, savingsCsvSources } = activity
  const entries = savings ? activity.savingsEntries : activity.entries
  const hydrated = savings ? activity.savingsHydrated : activity.hydrated
  const [filter, setFilter] = useState<Filter>("All")
  const visible = entries.filter((e) => matches(e, filter))

  return (
    <div className="ww-panel">
      <div className="ww-panel__head">
        <GradientText size={24} weight={700}>
          {savings ? "Savings activity" : "Activity"}
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
        {!savings && hydrated && requestsUnavailable && <RequestsUnavailableNotice />}
        {/* Pending lists the requests: the ones from outside the contacts collapse into their inbox. */}
        {!savings && filter === "Pending" && (
          <NonContactRequestsEntry className="ww-activity__requests-entry" />
        )}
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
        {!savings && filter === "Pending" && (
          <button
            type="button"
            className="zkm-btn-reset ww-activity__contacts"
            onClick={() => navigate("/contacts")}
          >
            See all contacts
          </button>
        )}
      </div>
      {hydrated && entries.length > 0 && csvSources && savingsCsvSources && (
        <div className="ww-activity__foot">
          <button
            type="button"
            className="zkm-btn-reset zkm-pressable ww-activity__export"
            onClick={() =>
              downloadCsv(
                savings ? savingsCsv(savingsCsvSources) : activityCsv(csvSources),
                activityCsvFileName(new Date(), savings ? "savings" : "main"),
              )
            }
          >
            Export CSV
            <Icon name="tray-deposit" size={14} />
          </button>
        </div>
      )}
      {detailModals}
    </div>
  )
}
