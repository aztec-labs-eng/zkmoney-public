/** The transactions sheet over the wallet's activity feed. */
import { formatDateLabel, type FeedItem } from "@obsidion/front-core"
import { ActivityDetailHost, useActivityHost } from "../../ui/activity/ActivityDetailHost"
import { ActivityRow } from "../../ui/activity/ActivityRow"
import { TransactionsSheet, type TransactionGroup } from "./TransactionsSheet"

/** Newest-first items under their day label. */
export function groupByDay(items: readonly FeedItem[]): TransactionGroup[] {
  const groups = new Map<string, FeedItem[]>()
  for (const item of items) {
    const label = formatDateLabel(item.ts)
    groups.set(label, [...(groups.get(label) ?? []), item])
  }
  return [...groups].map(([label, rows]) => ({
    label,
    rows: rows.map((item) => <ActivityRow key={item.id} item={item} />),
  }))
}

export function ChooseTransactions({ onClose }: { onClose: () => void }) {
  return (
    <ActivityDetailHost>
      <Transactions onClose={onClose} />
    </ActivityDetailHost>
  )
}

function Transactions({ onClose }: { onClose: () => void }) {
  const { feed } = useActivityHost()
  return (
    <TransactionsSheet groups={groupByDay(feed.items)} hydrated={feed.hydrated} onClose={onClose} />
  )
}
