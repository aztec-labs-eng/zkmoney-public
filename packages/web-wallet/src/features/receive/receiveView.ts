/** Pure view logic for the Receive flow. Kept UI-free so vitest covers it. */
import type { ContactRow } from "@obsidion/front-core"
import { decimalInput, parseAmount } from "../../ui/format"

/**
 * Rows for the entry modal's "Recent contacts" group: zk.money contacts only — a request needs an
 * L2 recipient. The directory carries no interaction recency, so list order stands in.
 */
export function recentContacts(contacts: ContactRow[], limit = 4): ContactRow[] {
  return contacts.filter((c) => c.addressKind === "aztec-l2").slice(0, limit)
}

/** Dollar amount for a request: strictly positive and finite, optional leading "$". */
export function parseRequestAmount(input: string): number | null {
  const raw = input.trim().replace(/^\$/, "")
  if (!raw) return null
  const n = parseAmount(decimalInput(raw))
  return Number.isFinite(n) && n > 0 ? n : null
}
