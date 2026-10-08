import * as actual from "../../../src/features/deposit/sipaProcessingObserver"
import {
  createSipaProcessingObserver,
  SIPADepositStore,
  type SIPADepositRecord,
  type SipaProcessingObserver,
} from "@obsidion/front-core"
import { getConfig } from "../../../src/config/env"
import { webStorage } from "../../../src/platform/storage/WebStorageAdapter"
import { depositCapacityStore } from "./capacity"
import { fixtureState } from "./control"
import { DEMO_ORIGIN, captureSipaPortalTerms } from "./processing-origin"

let observer: SipaProcessingObserver | undefined

/**
 * The production observer over the capture's capacity stores (`?capacityFixture=`, `capacity.ts`) and the demo portal,
 * so pending-deposit reasons render without a chain. Active in demo mode with a flow fixture; the original module
 * answers otherwise.
 */
export const sipaProcessingObserver: typeof actual.sipaProcessingObserver = () => {
  if (!fixtureState()) return actual.sipaProcessingObserver()
  if (observer) return observer
  const { l1ChainId } = getConfig()
  const store = SIPADepositStore.get(webStorage)
  // The seeded demo deposits predate origin and decimals and name another chain. Read, never written, as deposits on
  // the demo portal and chain.
  const asDemo = (record: SIPADepositRecord): SIPADepositRecord => ({
    ...record,
    l1ChainId,
    tokenDecimals: record.tokenDecimals ?? 18,
    origin: record.origin ?? DEMO_ORIGIN,
  })
  observer = createSipaProcessingObserver({
    deposits: {
      get: (address) => {
        const record = store.get(address)
        return record && asDemo(record)
      },
      list: () => store.list().map(asDemo),
      onListChanged: (listener) => store.onListChanged(listener),
    },
    capacity: depositCapacityStore,
    readTerms: captureSipaPortalTerms,
    l1ChainId,
  })
  return observer
}
