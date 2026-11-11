/**
 * The web wallet's pending-deposit processing observer: each funded, unswept deposit is read against its own portal
 * through the shared capacity registry. The UI capture replaces this module to drive capacity states without a chain.
 */
import {
  createSipaProcessingObserver,
  type ReadonlyStore,
  type RecordSet,
  type SipaDeposit,
  type SipaProcessingObserver,
} from "@obsidion/front-core"
import { isDemoMode } from "../../dev/demoFlag"
import type { Session } from "../../session/session"
import { depositCapacityStore } from "./capacityStore"

/** Undefined in demo mode, which has no L1 chain to read. */
export function sipaProcessingObserver(
  page: Pick<Session["page"], "config" | "chain" | "capacity">,
  deposits: ReadonlyStore<RecordSet<SipaDeposit>>,
): SipaProcessingObserver | undefined {
  if (import.meta.env.DEV && isDemoMode()) return undefined
  const { config, chain } = page
  return createSipaProcessingObserver({
    deposits,
    capacity: (key) => depositCapacityStore(page, key),
    terms: (route, token) => chain.sipaPortalTerms(route, token),
    l1ChainId: config.l1ChainId,
  })
}
