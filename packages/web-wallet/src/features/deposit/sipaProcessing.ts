/** The hook the deposit sheets read the processing observer through. */
import {
  memoryStore,
  sipaReasonShown,
  useStore,
  type SipaCapacityKey,
  type SipaProcessingState,
} from "@obsidion/front-core"
import { wallClock } from "../../lib/clock"
import { useSession } from "../../session/session"

const NOTHING_WAITS = memoryStore<ReadonlyMap<string, SipaProcessingState>>(new Map()).readonly

/**
 * One deposit's live processing state. `state` gates the manual sweep; `shown` is what a sheet states, by the shared
 * `sipaReasonShown` rule, and turns on by itself when the deposit reaches the stuck clock. `capacityKey` is the
 * original-portal bucket the observer reads, for a limits link beside the reason.
 */
export function useSipaProcessing(sipaAddress: string | undefined): {
  state?: SipaProcessingState
  shown?: SipaProcessingState
  capacityKey?: SipaCapacityKey
} {
  const { sipaDeposits, sipaProcessingObserver: observer } = useSession()
  // Watching the states runs the observer's reads; a portal lookup also changes them.
  useStore(observer?.states ?? NOTHING_WAITS)
  const id = sipaAddress?.toLowerCase()
  const record = useStore(sipaDeposits.view, ({ records }) =>
    records.find((r) => r.sipaAddress.toLowerCase() === id),
  )
  const now = useStore(wallClock)
  const state = sipaAddress ? observer?.stateFor(sipaAddress) : undefined
  // With no rail record the deposit is not on the stuck clock: only a blocker is stated.
  const shown = sipaReasonShown(state, record ?? { phase: "funded", startTime: now }, now)
  const capacityKey = sipaAddress ? observer?.capacityKeyFor(sipaAddress) : undefined
  return { state, shown: shown ? state : undefined, capacityKey }
}
