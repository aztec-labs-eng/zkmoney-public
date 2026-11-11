import { memoryStore, useStore, type AllowanceSnapshot } from "@obsidion/front-core"
import { useSession } from "../../session/session"

const UNREAD = memoryStore<AllowanceSnapshot>({ status: "loading" }).readonly

/**
 * The session's sponsored-transaction allowance, read again when a first reader opens. An inactive
 * reader starts no read.
 */
export function useSponsoredAllowance(active = true): {
  snapshot: AllowanceSnapshot
  refresh: () => void
} {
  const { sponsoredAllowance: allowance } = useSession()
  const snapshot = useStore(active && allowance ? allowance.snapshot : UNREAD)
  return { snapshot, refresh: () => allowance?.refresh() }
}
