/**
 * The processing observer's browser consumers: the activity feed it annotates and the hook the deposit sheets read.
 */
import { useEffect, useState } from "react"
import type { Address } from "viem"
import {
  ActivityFeed,
  isStuckSweep,
  sipaReasonShown,
  SIPADepositStore,
  STUCK_SWEEP_MS,
  type SipaCapacityKey,
  type SipaProcessingState,
} from "@obsidion/front-core"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { getWithdrawalStore } from "../withdraw/withdrawGateway"
import { sipaProcessingObserver } from "./sipaProcessingObserver"

export { sipaProcessingObserver }

let attached = false

/** The page's one activity feed, with pending deposits annotated by the observer. */
export function bridgeActivityFeed(): ActivityFeed {
  const feed = ActivityFeed.get(SIPADepositStore.get(webStorage), getWithdrawalStore())
  const source = sipaProcessingObserver()
  if (source && !attached) {
    attached = true
    feed.setProcessingSource(source)
  }
  return feed
}

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
  const source = sipaProcessingObserver()
  const [state, setState] = useState(() =>
    sipaAddress ? source?.stateFor(sipaAddress) : undefined,
  )
  const [, tick] = useState(0)
  useEffect(() => {
    if (!source || !sipaAddress) {
      setState(undefined)
      return
    }
    // A key change can leave the state as it was (a deposit not waiting for its sweep), so always re-render.
    const update = () => {
      setState(source.stateFor(sipaAddress))
      tick((n) => n + 1)
    }
    const stop = source.subscribe(update)
    update()
    return stop
  }, [source, sipaAddress])
  const record = sipaAddress ? SIPADepositStore.get(webStorage).get(sipaAddress as Address) : null
  const now = Date.now()
  const stuckAt =
    state && record && !isStuckSweep(record, now) ? record.startTime + STUCK_SWEEP_MS : undefined
  useEffect(() => {
    if (stuckAt === undefined) return
    const timer = setTimeout(() => tick((n) => n + 1), Math.max(0, stuckAt - Date.now()))
    return () => clearTimeout(timer)
  }, [stuckAt])
  // With no rail record the deposit is not on the stuck clock: only a blocker is stated.
  const shown = sipaReasonShown(state, record ?? { phase: "funded", startTime: now }, now)
  const capacityKey = sipaAddress ? source?.capacityKeyFor(sipaAddress) : undefined
  return { state, shown: shown ? state : undefined, capacityKey }
}
