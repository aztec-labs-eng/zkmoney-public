/**
 * The Standard/Faster choice every tipped burn offers, and the row that shows it. A flow reads the
 * choice, prices its fee with `pricedTip`, then settles the tip it burns against what it can afford.
 */
import { useEffect, useState } from "react"
import type { WithdrawalSpeedupNode } from "@obsidion/front-core"
import {
  fasterIsWorthIt,
  useFasterWithdrawal,
  type FasterWithdrawal,
  type LoadFasterWithdrawal,
} from "./useFasterWithdrawal"
import {
  WithdrawalSpeedChecking,
  WithdrawalSpeedPicker,
  type WithdrawalSpeed,
} from "./WithdrawalSpeedPicker"
import { formatPublicLimit } from "../limits/publicLimit"

export const FASTER_BLOCKED_COPY = "The amount can't cover the tip"
/** Why Faster is refused where the tip rides on top of the amount. */
export const BALANCE_TIP_BLOCKED_COPY = "Your balance can't cover the tip"
export const LIMIT_TIP_BLOCKED_COPY = `The tip would put this over the ${formatPublicLimit()} limit`

export interface SpeedChoice {
  offer?: FasterWithdrawal
  /** The first quote is still out. */
  loading: boolean
  speed: WithdrawalSpeed
  setSpeed: (speed: WithdrawalSpeed) => void
  /** No tip would help: Faster shows as chosen and the burn carries none. */
  settled: boolean
  /** An offer a planned burn is bound to: it stands whatever later quotes say. */
  held: boolean
  /** The tip to price the fee with: the chosen one, before affordability is known. */
  pricedTip: bigint
}

/** The most a tip may cost for Faster to be the opening choice: 2 DAI. */
export const FASTER_DEFAULT_MAX_TIP = 2n * 10n ** 18n
/** Faster opens only when the tip is at most this share of the amount, in percent. */
export const FASTER_DEFAULT_MAX_TIP_PERCENT = 10n

/** Whether a choice nobody has made yet opens on Faster: a proven-useful tip that is cheap in absolute and relative terms. */
export const opensOnFaster = (offer: FasterWithdrawal, amount: bigint) =>
  offer.measured &&
  offer.proverTip <= FASTER_DEFAULT_MAX_TIP &&
  offer.proverTip * 100n <= amount * FASTER_DEFAULT_MAX_TIP_PERCENT

export function useSpeedChoice({
  active,
  node,
  amount,
  initialSpeed,
  answerWithinMs,
  load,
  held,
}: {
  active: boolean
  node?: WithdrawalSpeedupNode
  /** What the burn moves, in the tip's token; the opening choice weighs the tip against it. */
  amount?: bigint
  /** Overrides the opening choice, which is otherwise decided once by {@link opensOnFaster}. */
  initialSpeed?: WithdrawalSpeed
  answerWithinMs?: number
  load?: LoadFasterWithdrawal
  held?: FasterWithdrawal
}): SpeedChoice {
  const [chosen, setSpeed] = useState<WithdrawalSpeed | undefined>(initialSpeed)
  const live = useFasterWithdrawal({ active, node, answerWithinMs, load })
  const offer = held ?? live.offer
  // Fixed by the first offer, so re-quotes around the limit never flip it; reopened with the flow.
  const [opening, setOpening] = useState<WithdrawalSpeed>()
  if (!active && opening !== undefined) setOpening(undefined)
  if (active && opening === undefined && offer && amount !== undefined) {
    setOpening(opensOnFaster(offer, amount) ? "faster" : "standard")
  }
  const speed = chosen ?? opening ?? "standard"
  const settled = !held && !!offer && !fasterIsWorthIt(offer)
  const pricedTip = speed === "faster" && offer && !settled ? offer.proverTip : 0n
  return { offer, loading: live.loading, speed, setSpeed, settled, held: !!held, pricedTip }
}

export interface SpeedOutcome {
  /** Why Faster cannot be chosen; the choice falls back to Standard. */
  blocked?: string
  /** What the burn carries. */
  proverTip: bigint
}

/**
 * The tip a choice burns once `covers` says whether the flow can afford the offer's tip; undefined
 * while that is unknown, which blocks nothing.
 */
export function useSpeedOutcome(
  choice: SpeedChoice,
  covers: boolean | undefined,
  blockedCopy = FASTER_BLOCKED_COPY,
): SpeedOutcome {
  const { offer, settled, held, speed, setSpeed } = choice
  const blocked = offer && !settled && !held && covers === false ? blockedCopy : undefined
  useEffect(() => {
    if (blocked) setSpeed("standard")
  }, [blocked, setSpeed])
  const proverTip = speed === "faster" && offer && !settled && !blocked ? offer.proverTip : 0n
  return { blocked, proverTip }
}

/** The Speed row: checking while the first quote is out, then the choice; nothing without an offer. */
export function SpeedRow({ choice, outcome }: { choice: SpeedChoice; outcome: SpeedOutcome }) {
  if (!choice.offer) return choice.loading ? <WithdrawalSpeedChecking /> : null
  return (
    <WithdrawalSpeedPicker
      value={choice.speed}
      onChange={choice.setSpeed}
      faster={choice.offer}
      settled={choice.settled}
      fasterBlocked={outcome.blocked}
    />
  )
}
