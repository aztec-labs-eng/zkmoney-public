import { useState } from "react"
import { ActivityListSkeleton } from "../Skeletons"
import type { ActivityEntry } from "./useActivityEntries"

const HOME_TXN_TABS = ["Transactions", "Pending"] as const

/** The wallet card's recent-activity widget: two tabs over a feed, three newest rows. */
export function HomeTransactions({
  entries,
  hydrated,
  onViewAll,
}: {
  entries: ActivityEntry[]
  hydrated: boolean
  onViewAll: () => void
}) {
  const [tab, setTab] = useState<(typeof HOME_TXN_TABS)[number]>("Transactions")
  const visible = (tab === "Pending" ? entries.filter((e) => e.pending) : entries).slice(0, 3)

  return (
    <div className="ww-home-txns">
      <div className="ww-home-txns__bar">
        <div className="ww-home-txns__tabs">
          {HOME_TXN_TABS.map((t) => (
            <button
              aria-pressed={tab === t}
              key={t}
              type="button"
              className="zkm-btn-reset"
              data-active={tab === t || undefined}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
        <button type="button" className="zkm-btn-reset ww-home-txns__viewall" onClick={onViewAll}>
          View all
        </button>
      </div>
      <div className="ww-home-txns__rows">
        {!hydrated && <ActivityListSkeleton rows={3} />}
        {hydrated && visible.map((entry) => entry.node)}
        {hydrated && visible.length === 0 && (
          <span className="ww-home-txns__empty">
            {tab === "Pending" ? "Nothing pending." : "No transactions yet."}
          </span>
        )}
      </div>
    </div>
  )
}
