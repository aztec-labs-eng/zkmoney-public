/**
 * The web wallet's pending-deposit processing observer: each funded, unswept deposit is read against its own portal
 * through the shared capacity registry. The UI capture replaces this module to drive capacity states without a chain.
 */
import type { Address } from "viem"
import { readSipaPortalTerms } from "@obsidion/sdk"
import {
  createSipaProcessingObserver,
  type ReadonlyStore,
  type RecordSet,
  type SipaDeposit,
  type SipaProcessingObserver,
} from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { isDemoMode } from "../../dev/demoFlag"
import { getOxideTuple, l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import { depositCapacityStore } from "./capacityStore"

/** Undefined until the config profile has booted, and in demo mode: neither has an L1 chain to read. */
export function sipaProcessingObserver(
  deposits: ReadonlyStore<RecordSet<SipaDeposit>>,
): SipaProcessingObserver | undefined {
  if (import.meta.env.DEV && isDemoMode()) return undefined
  let config: ReturnType<typeof getConfig>
  try {
    config = getConfig()
  } catch {
    return undefined
  }
  let client: ReturnType<typeof l1PublicClient> | undefined
  return createSipaProcessingObserver({
    deposits,
    capacity: depositCapacityStore,
    readTerms: async (route) =>
      readSipaPortalTerms((client ??= l1PublicClient(config)), {
        ...route,
        token: requireTupleField(await getOxideTuple(config), "token") as Address,
      }),
    l1ChainId: config.l1ChainId,
  })
}
