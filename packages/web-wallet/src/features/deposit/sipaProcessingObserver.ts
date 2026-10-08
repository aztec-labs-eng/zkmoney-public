/**
 * The web wallet's one pending-deposit processing observer: each funded, unswept deposit is read against its own
 * portal through the shared capacity registry. The UI capture replaces this module to drive capacity states without a
 * chain.
 */
import type { Address } from "viem"
import { readSipaPortalTerms } from "@obsidion/sdk"
import {
  createSipaProcessingObserver,
  SIPADepositStore,
  type SipaProcessingObserver,
} from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { isDemoMode } from "../../dev/demoFlag"
import { l1PublicClient } from "../../config/oxideTuple"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { depositCapacityStore } from "./capacityStore"

let observer: SipaProcessingObserver | undefined

/** Undefined until the config profile has booted, and in demo mode: neither has an L1 chain to read. */
export function sipaProcessingObserver(): SipaProcessingObserver | undefined {
  if (observer) return observer
  if (import.meta.env.DEV && isDemoMode()) return undefined
  let config: ReturnType<typeof getConfig>
  try {
    config = getConfig()
  } catch {
    return undefined
  }
  let client: ReturnType<typeof l1PublicClient> | undefined
  observer = createSipaProcessingObserver({
    deposits: SIPADepositStore.get(webStorage),
    capacity: depositCapacityStore,
    readTerms: async (implementation: Address) =>
      readSipaPortalTerms((client ??= l1PublicClient(config)), implementation),
    l1ChainId: config.l1ChainId,
  })
  return observer
}
