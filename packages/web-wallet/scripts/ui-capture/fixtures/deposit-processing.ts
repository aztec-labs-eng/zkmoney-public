import * as actual from "../../../src/features/deposit/sipaProcessingObserver"
import { createPace } from "@obsidion/core/cadence"
import {
  createSipaProcessingObserver,
  derived,
  memoryStore,
  queries,
  type SipaDeposit,
} from "@obsidion/front-core"
import { depositCapacityStore } from "./capacity"
import { fixtureState } from "./control"
import { DEMO_ORIGIN, captureSipaPortalTerms } from "./processing-origin"

/**
 * The production observer over the capture's capacity stores (`?capacityFixture=`, `capacity.ts`) and the demo portal,
 * so pending-deposit reasons render without a chain. Active in demo mode with a flow fixture; the original module
 * answers otherwise.
 */
export const sipaProcessingObserver: typeof actual.sipaProcessingObserver = (page, deposits) => {
  if (!fixtureState()) return actual.sipaProcessingObserver(page, deposits)
  const { l1ChainId } = page.config
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
    capacity: (key) => depositCapacityStore(page, key),
    terms: queries({ pace: createPace(), visible: memoryStore(true).readonly, now: Date.now })(
      "captureSipaPortalTerms",
      { load: captureSipaPortalTerms },
    ),
    l1ChainId,
  })
}
