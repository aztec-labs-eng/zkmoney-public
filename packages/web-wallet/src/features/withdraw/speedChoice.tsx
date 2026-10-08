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

export function useSpeedChoice({
  active,
  node,
  initialSpeed = "standard",
  answerWithinMs,
  load,
  held,
  legs,
}: {
  active: boolean
  node?: WithdrawalSpeedupNode
  /** Burns sent one after another; the tip rides the last. */
  legs?: number
  initialSpeed?: WithdrawalSpeed
  answerWithinMs?: number
  load?: LoadFasterWithdrawal
  held?: FasterWithdrawal
}): SpeedChoice {
  const [speed, setSpeed] = useState<WithdrawalSpeed>(initialSpeed)
  const live = useFasterWithdrawal({ active, node, legs, answerWithinMs, load })
  const offer = held ?? live.offer
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
