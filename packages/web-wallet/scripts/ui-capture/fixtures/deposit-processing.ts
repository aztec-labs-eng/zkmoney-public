import * as actual from "../../../src/features/deposit/sipaProcessingObserver"
import { createSipaProcessingObserver, derived, type SipaDeposit } from "@obsidion/front-core"
import { getConfig } from "../../../src/config/env"
import { depositCapacityStore } from "./capacity"
import { fixtureState } from "./control"
import { DEMO_ORIGIN, captureSipaPortalTerms } from "./processing-origin"

/**
 * The production observer over the capture's capacity stores (`?capacityFixture=`, `capacity.ts`) and the demo portal,
 * so pending-deposit reasons render without a chain. Active in demo mode with a flow fixture; the original module
 * answers otherwise.
 */
export const sipaProcessingObserver: typeof actual.sipaProcessingObserver = (deposits) => {
  if (!fixtureState()) return actual.sipaProcessingObserver(deposits)
  const { l1ChainId } = getConfig()
  // The seeded demo deposits predate origin and decimals and name another chain. Read, never written, as deposits on
  // the demo portal and chain.
  const asDemo = (record: SipaDeposit): SipaDeposit => ({
    ...record,
    l1ChainId,
    tokenDecimals: record.tokenDecimals ?? 18,
    origin: record.origin ?? DEMO_ORIGIN,
  })
  return createSipaProcessingObserver({
    deposits: derived([deposits], (set) => ({ ...set, records: set.records.map(asDemo) })),
    capacity: depositCapacityStore,
    readTerms: captureSipaPortalTerms,
    l1ChainId,
  })
}
