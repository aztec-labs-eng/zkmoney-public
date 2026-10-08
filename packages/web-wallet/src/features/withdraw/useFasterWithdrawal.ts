import { useEffect, useState } from "react"
import type { Network } from "@obsidion/core/constants"
import {
  WithdrawalSpeedupEstimator,
  type WithdrawalSpeedupEstimate,
  type WithdrawalSpeedupNode,
} from "@obsidion/front-core"
import { quoteWithdrawalProverTip, type ProverTipQuote } from "@obsidion/sdk"
import type { Address, PublicClient } from "viem"
import { getConfig } from "../../config/env"
import { getOxideTuple, l1PublicClient } from "../../config/oxideTuple"
import { SWAP_QUOTE_REFRESH_MS } from "./withdrawQuote"
import { burnLanding, sequentialLanding } from "./burnTiming"

/** A tip that saves less than this for certain is not worth paying. */
export const FASTER_WITHDRAWAL_MIN_SPEEDUP_SECONDS = 60

/** The faster option: its tip and both ETAs, in seconds from now. */
export interface FasterWithdrawal {
  proverTip: bigint
  standardEtaSeconds: number
  tippedEtaSeconds: number
  /** What the tip saves wherever in this device's landing window the burn lands. */
  worstSpeedupSeconds: number
}

/** Whether a tip buys at least {@link FASTER_WITHDRAWAL_MIN_SPEEDUP_SECONDS} for certain. */
export const fasterIsWorthIt = (offer: FasterWithdrawal) =>
  offer.worstSpeedupSeconds >= FASTER_WITHDRAWAL_MIN_SPEEDUP_SECONDS

/** For `legs` burns sent one after another the window is the last one's. */
export type LoadFasterWithdrawal = (
  node: WithdrawalSpeedupNode,
  legs?: number,
) => Promise<{ estimate: WithdrawalSpeedupEstimate; quote: ProverTipQuote }>

/** The offer one load makes; none when the tip is zero. */
export function fasterWithdrawalOffer({
  estimate,
  quote,
}: Awaited<ReturnType<LoadFasterWithdrawal>>): FasterWithdrawal | undefined {
  return quote.proverTip > 0n
    ? {
        proverTip: quote.proverTip,
        standardEtaSeconds: estimate.standardEtaSeconds,
        tippedEtaSeconds: estimate.tippedEtaSeconds,
        worstSpeedupSeconds: estimate.worstSpeedupSeconds,
      }
    : undefined
}

// Keeps the proof-latency calibration across quotes.
let estimatorCache:
  | { network: Network; node: WithdrawalSpeedupNode; estimator: WithdrawalSpeedupEstimator }
  | undefined

function speedupEstimator(
  network: Network,
  node: WithdrawalSpeedupNode,
  publicClient: PublicClient,
): WithdrawalSpeedupEstimator {
  if (estimatorCache?.network !== network || estimatorCache.node !== node) {
    estimatorCache = {
      network,
      node,
      estimator: new WithdrawalSpeedupEstimator({ node, publicClient }),
    }
  }
  return estimatorCache.estimator
}

export const loadFasterWithdrawal: LoadFasterWithdrawal = async (node, legs = 1) => {
  const config = getConfig()
  const tuple = await getOxideTuple(config)
  const publicClient = l1PublicClient(config)
  const estimate = await speedupEstimator(config.network, node, publicClient).estimate(
    sequentialLanding(await burnLanding(), legs),
  )
  const quote = await quoteWithdrawalProverTip(publicClient, {
    chainId: BigInt(config.l1ChainId),
    proverSubsidy: tuple.proverSubsidy as Address | undefined,
    checkpointCount: BigInt(estimate.checkpointIndex),
  })
  return { estimate, quote }
}

/** The faster option, and whether its first quote is still being worked out. */
export interface FasterWithdrawalState {
  offer?: FasterWithdrawal
  loading: boolean
}

/**
 * The faster option while `active`, re-quoted every {@link SWAP_QUOTE_REFRESH_MS}: waiting moves the burn
 * later in its epoch. No offer while loading, when a read fails, and when the tip is zero.
 */
export function useFasterWithdrawal({
  active,
  node,
  legs = 1,
  load = loadFasterWithdrawal,
  refreshMs = SWAP_QUOTE_REFRESH_MS,
  answerWithinMs,
}: {
  active: boolean
  node?: WithdrawalSpeedupNode
  /** Burns sent one after another; the tip rides the last. */
  legs?: number
  load?: LoadFasterWithdrawal
  refreshMs?: number
  /** Stop loading after this long without a first answer; a later answer still lands. */
  answerWithinMs?: number
}): FasterWithdrawalState {
  const [offer, setOffer] = useState<FasterWithdrawal | undefined>(undefined)
  const [answered, setAnswered] = useState(false)
  const on = active && node !== undefined

  useEffect(() => {
    setOffer(undefined)
    setAnswered(false)
    if (!active || !node) return
    let live = true
    let inFlight = false
    let loadedAt = Date.now()
    const run = async () => {
      if (inFlight) {
        // A read slower than two refreshes leaves an offer for a burn that would now land later.
        if (Date.now() - loadedAt > 2 * refreshMs) {
          setOffer(undefined)
          setAnswered(true)
        }
        return
      }
      inFlight = true
      try {
        const loaded = await load(node, legs)
        if (!live) return
        loadedAt = Date.now()
        setOffer(fasterWithdrawalOffer(loaded))
      } catch {
        if (live) setOffer(undefined)
      } finally {
        inFlight = false
        if (live) setAnswered(true)
      }
    }
    void run()
    const interval = window.setInterval(() => void run(), refreshMs)
    const giveUp =
      answerWithinMs === undefined
        ? undefined
        : window.setTimeout(() => live && setAnswered(true), answerWithinMs)
    return () => {
      live = false
      window.clearInterval(interval)
      window.clearTimeout(giveUp)
    }
  }, [active, node, legs, load, refreshMs, answerWithinMs])

  return on ? { offer, loading: !answered } : { loading: false }
}
