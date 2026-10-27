import { Fragment, useState, type ReactNode } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { DEFAULT_DECIMALS, WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import {
  activityCsv,
  activityCsvFileName,
  csvWalletToken,
  formatDateLabel,
  savingsCsv,
  selectActivity,
  TokenStorage,
  useAssetContext,
  useStore,
  type ActivityCsvToken,
  type ActivityFilter,
} from "@obsidion/front-core"
import { isDemoMode } from "../../dev/demoFlag"
import { GradientText, Icon } from "@obsidion/web-ds"
import { NonContactRequestsEntry } from "../../features/requests/NonContactRequestsScreen"
import { RequestsUnavailableNotice } from "../../features/requests/RequestsUnavailableNotice"
import { fmt } from "../../lib/fmt"
import { ActivityDetailHost, useActivityHost } from "../activity/ActivityDetailHost"
import { ActivityRow, SavingsActivityRow } from "../activity/ActivityRow"
import { ActivityListSkeleton } from "../Skeletons"
import copy from "./ActivityScreen.copy"

const FILTERS = ["All", "Sent", "Received", "Pending"] as const satisfies readonly ActivityFilter[]

/** Newest-first items bucketed under their day label (Today / Yesterday / date). */
function groupByDay<T extends { ts: number }>(items: readonly T[]): [string, T[]][] {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const label = formatDateLabel(item.ts)
    groups.set(label, [...(groups.get(label) ?? []), item])
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

/** Demo mode boots no token service; its fixtures are in the wallet token. */
const DEMO_WALLET_TOKEN: ActivityCsvToken = {
  symbol: WALLET_TOKEN_SYMBOL,
  decimals: DEFAULT_DECIMALS,
}

/** The Main token the exports report in; saved activity needs no current balance. */
function useWalletToken(): ActivityCsvToken | undefined {
  const { tokenService, decimalsChecked } = useAssetContext()
  const rows = useStore(TokenStorage.get().rows, (r) => r.value)
  return csvWalletToken(rows, tokenService?.tokenAddressOrNull?.toString(), decimalsChecked)
}

/**
 * Activity panel: the unified feed with direction/pending filter chips, grouped by day. With
 * `?account=savings` it is the Savings account's feed and export, as Savings' Home shows it.
 */
export function ActivityScreen() {
  return (
    <ActivityDetailHost>
      <Activity />
    </ActivityDetailHost>
  )
}

function Activity() {
  const { feed } = useActivityHost()
  const walletToken =
    useWalletToken() ?? (import.meta.env.DEV && isDemoMode() ? DEMO_WALLET_TOKEN : undefined)
  const navigate = useNavigate()
  const savings = useSearchParams()[0].get("account") === "savings"
  const [filter, setFilter] = useState<ActivityFilter>("All")
  const hydrated = savings ? feed.savings.hydrated : feed.hydrated
  const total = savings ? feed.savings.items.length : feed.items.length
  const list: [string, ReactNode[]][] = savings
    ? groupByDay(selectActivity(feed.savings.items, filter)).map(([label, items]) => [
        label,
        items.map((item) => <SavingsActivityRow key={item.id} item={item} />),
      ])
    : groupByDay(selectActivity(feed.items, filter)).map(([label, items]) => [
        label,
        items.map((item) => (
          <Fragment key={item.id}>
            <ActivityRow item={item} />
          </Fragment>
        )),
      ])

  return (
    <div className="ww-panel">
      <div className="ww-panel__head">
        <GradientText size={24} weight={700}>
          {savings ? copy.savingsTitle : copy.title}
        </GradientText>
      </div>
      <div className="ww-panel__scroll">
        <div className="ww-chip-row" style={{ marginBottom: 0 }}>
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              className="zkm-btn-reset zkm-pressable ww-activity__chip"
              data-active={filter === f || undefined}
              onClick={() => setFilter(f)}
            >
              {copy.filters[f]}
            </button>
          ))}
        </div>
        {!savings && hydrated && feed.requestsUnavailable && <RequestsUnavailableNotice />}
        {/* Pending lists the requests: the ones from outside the contacts collapse into their inbox. */}
        {!savings && filter === "Pending" && (
          <NonContactRequestsEntry className="ww-activity__requests-entry" />
        )}
        {!hydrated && <ActivityListSkeleton rows={5} />}
        {hydrated && list.length > 0 && (
          <div className="ww-activity__list">
            {list.map(([label, rows]) => (
              <div key={label} className="ww-contacts__section">
                <span className="ww-contacts__label">{label}</span>
                <div className="ww-activity__group">{rows}</div>
              </div>
            ))}
          </div>
        )}
        {hydrated && list.length === 0 && (
          <div className="ww-empty">
            <span>
              {total === 0
                ? copy.empty
                : fmt(copy.emptyFilter, { filter: copy.filters[filter].toLowerCase() })}
            </span>
          </div>
        )}
        {!savings && filter === "Pending" && (
          <button
            type="button"
            className="zkm-btn-reset ww-activity__contacts"
            onClick={() => navigate("/contacts")}
          >
            {copy.seeContacts}
          </button>
        )}
      </div>
      {hydrated && total > 0 && walletToken && (
        <div className="ww-activity__foot">
          <button
            type="button"
            className="zkm-btn-reset zkm-pressable ww-activity__export"
            onClick={() =>
              downloadCsv(
                savings
                  ? savingsCsv({ ...feed.savingsCsv, walletToken })
                  : activityCsv({ ...feed.csv, walletToken }),
                activityCsvFileName(new Date(), savings ? "savings" : "main"),
              )
            }
          >
            {copy.export}
            <Icon name="tray-deposit" size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
