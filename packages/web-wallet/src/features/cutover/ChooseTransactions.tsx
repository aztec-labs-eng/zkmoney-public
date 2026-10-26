/** The transactions sheet over the wallet's activity feed. */
import { formatDateLabel } from "@obsidion/front-core"
import { useActivityEntries, type ActivityEntry } from "../../ui/screens/useActivityEntries"
import { TransactionsSheet, type TransactionGroup } from "./TransactionsSheet"

/** Newest-first entries under their day label. */
export function groupByDay(entries: ActivityEntry[]): TransactionGroup[] {
  const groups = new Map<string, ActivityEntry[]>()
  for (const entry of entries) {
    const label = formatDateLabel(entry.ts)
    groups.set(label, [...(groups.get(label) ?? []), entry])
  }
  return [...groups].map(([label, rows]) => ({ label, rows: rows.map((entry) => entry.node) }))
}

export function ChooseTransactions({ onClose }: { onClose: () => void }) {
  const { entries, hydrated, detailModals } = useActivityEntries()
  return (
    <TransactionsSheet groups={groupByDay(entries)} hydrated={hydrated} onClose={onClose}>
      {detailModals}
    </TransactionsSheet>
  )
}
