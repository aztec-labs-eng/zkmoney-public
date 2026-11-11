import { useState } from "react"
import {
  service,
  serviceStatus,
  UNREAD,
  useStore,
  type QueryState,
  WithdrawalSpeedupEstimator,
  type BurnDurations,
  type Service,
  type WithdrawalSpeedupEstimate,
} from "@obsidion/front-core"
import { quoteWithdrawalProverTip, type ObsidionWallet, type ProverTipQuote } from "@obsidion/sdk"
import type { Address } from "viem"
import type { WebWalletConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"
import { SWAP_QUOTE_MAX_AGE_MS } from "./swapQuotes"
import { burnLanding } from "./burnTiming"
import { useSession, type Session } from "../../session/session"

/** A tip that saves less than this for certain is not worth paying. */
export const FASTER_WITHDRAWAL_MIN_SPEEDUP_SECONDS = 60

/** The faster option: its tip and both ETAs, in seconds from now. */
export interface FasterWithdrawal {
  proverTip: bigint
  standardEtaSeconds: number
  tippedEtaSeconds: number
  /** What the tip saves wherever in this device's landing window the burn lands. */
  worstSpeedupSeconds: number
  /** The ETAs come from recent L1 proofs, so a prover is known to act on tips. */
  measured: boolean
}

/** Whether a tip buys at least {@link FASTER_WITHDRAWAL_MIN_SPEEDUP_SECONDS} for certain. */
export const fasterIsWorthIt = (offer: FasterWithdrawal) =>
  offer.worstSpeedupSeconds >= FASTER_WITHDRAWAL_MIN_SPEEDUP_SECONDS

/** One quote's reads: where the burn lands in its epoch, and the tip for its checkpoint. */
export interface FasterWithdrawalQuote {
  estimate: WithdrawalSpeedupEstimate
  quote: ProverTipQuote
}

/** The offer one load makes; none when the tip is zero or the burn may land past the tip cutoff. */
export function fasterWithdrawalOffer({
  estimate,
  quote,
}: FasterWithdrawalQuote): FasterWithdrawal | undefined {
  return quote.proverTip > 0n && !estimate.pastTipCutoff
    ? {
        proverTip: quote.proverTip,
        standardEtaSeconds: estimate.standardEtaSeconds,
        tippedEtaSeconds: estimate.tippedEtaSeconds,
        worstSpeedupSeconds: estimate.worstSpeedupSeconds,
        measured: estimate.confidence === "measured",
      }
    : undefined
}

/** The page's estimator over its wallet's node: it keeps the proof-latency calibration across flows. */
export const pageSpeedupEstimator = (
  wallet: Service<ObsidionWallet>,
  config: WebWalletConfig,
): Service<WithdrawalSpeedupEstimator> =>
  service(
    "speedupEstimator",
    { from: [wallet], retry: "manual" },
    async ([wallet]) =>
      new WithdrawalSpeedupEstimator({ node: wallet.node, publicClient: l1PublicClient(config) }),
  )

/** The offer's reads, a demo page's in place of {@link loadFasterWithdrawal}. */
export type LoadFasterWithdrawal = (signal: AbortSignal) => Promise<FasterWithdrawalQuote>

/** The offer's reads: this device's burn timing, the burn's checkpoint and the tip for it. */
export const loadFasterWithdrawal = async (
  durations: BurnDurations,
  page: Pick<Session["page"], "config" | "chain" | "speedupEstimator">,
  signal: AbortSignal,
): Promise<FasterWithdrawalQuote> => {
  const { config, chain } = page
  const tuple = await chain.oxideTuple.read(signal)
  const publicClient = l1PublicClient(config)
  const estimator = await page.speedupEstimator.ready(signal)
  const estimate = await estimator.estimate(await burnLanding(durations))
  const quote = await quoteWithdrawalProverTip(publicClient, {
    chainId: BigInt(config.l1ChainId),
    proverSubsidy: tuple.proverSubsidy as Address | undefined,
    checkpointCount: BigInt(estimate.checkpointIndex),
  })
  return { estimate, quote }
}

/** The standard ETA, in seconds from now, known whether or not a tip is offered. */
export interface WithdrawalEta {
  standardSeconds: number
}

/** One quote's offer, stamped with when it was asked, or none, stamped with when it failed or gave up. */
export interface QuotedOffer {
  offer?: FasterWithdrawal
  eta?: WithdrawalEta
  quotedAt: number
}

/** The faster option, the standard ETA, and whether the first quote is still being worked out. */
export interface FasterWithdrawalState {
  offer?: FasterWithdrawal
  eta?: WithdrawalEta
  /** The offer is from a quote that has settled, with no newer one out. */
  current: boolean
  loading: boolean
}

/**
 * The offer as a view shows it at `now`: none once two refreshes old, and current only while no
 * quote is out. It loads until a quote answers, or until the view's own wait ends at `waitEndsAt`.
 */
export function shownOffer(
  state: QueryState<QuotedOffer>,
  now: number,
  waitEndsAt?: number,
): FasterWithdrawalState {
  const value = state.status === "ready" ? state.value : undefined
  const young = value !== undefined && now - value.quotedAt < SWAP_QUOTE_MAX_AGE_MS
  const offer = young ? value.offer : undefined
  return {
    offer,
    eta: young ? value.eta : undefined,
    current: offer !== undefined && state.status === "ready" && !state.refreshing,
    loading: !young && !(waitEndsAt !== undefined && now >= waitEndsAt),
  }
}

/**
 * The faster option while `active` and the wallet's node is up; none while loading or at a zero tip.
 * It loads until a quote answers or gives up, or until `answerWithinMs` after the view opened.
 */
export function useFasterWithdrawal({
  active,
  answerWithinMs,
}: {
  active: boolean
  /** A shorter wait of the view's own for its first quote. */
  answerWithinMs?: number
}): FasterWithdrawalState {
  const { fasterOffer, page, wallet } = useSession()
  const built = useStore(wallet, serviceStatus) === "ready"
  // A demo page's stand-in reads no node, so it needs no wallet.
  const on = active && (!!page.loaders.fasterOffer || built)
  const [openedAt, setOpenedAt] = useState<number>()
  if (on !== (openedAt !== undefined)) setOpenedAt(on ? page.now() : undefined)
  const state = useStore(on ? fasterOffer : UNREAD)
  const now = useStore(page.seconds)
  if (!on || openedAt === undefined) return { current: false, loading: false }
  return shownOffer(
    state,
    now,
    answerWithinMs === undefined ? undefined : openedAt + answerWithinMs,
  )
}
