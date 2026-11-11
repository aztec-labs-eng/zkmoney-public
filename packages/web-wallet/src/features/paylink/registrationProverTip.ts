/**
 * The speed a ticket registration's burn takes. Registration needs no tip, so Faster, the default,
 * tips only when that buys a faster withdrawal and the note still covers the burn with it. The
 * user's tap commits the decision a surface shows, and the claim burns what was committed. A tap
 * before the quote answers commits Standard.
 */
import { useState } from "react"
import type { RegistrationSchedule } from "@obsidion/core/types"
import { goldenTicketCoverage } from "@obsidion/front-core"
import {
  useSpeedChoice,
  useSpeedOutcome,
  type SpeedChoice,
  type SpeedOutcome,
} from "../withdraw/speedChoice"
import type { WithdrawalSpeed } from "../withdraw/WithdrawalSpeedPicker"

/** A registration waits this long for its first quote, then goes ahead without a tip. */
export const REGISTRATION_OFFER_TIMEOUT_MS = 15_000

export const REGISTRATION_TIP_BLOCKED_COPY = "The payment can't cover the tip"

/** A tap's commit: the tip, its speed, and the withdrawal fee the split was priced with. */
export interface SpeedDecision {
  tip: bigint
  speed: WithdrawalSpeed
  withdrawalFee?: bigint
  /** How many speeds the user had picked when this decision showed. */
  picks: number
}

/**
 * The decision once a ceremony gate resolves. A gate can resolve with no tap, after its own probes,
 * so only a speed the user picked while it was open replaces the one the tap noted.
 */
export const afterGate = (noted: SpeedDecision | undefined, shown: SpeedDecision | undefined) =>
  shown && shown.picks !== noted?.picks ? shown : noted

export interface RegistrationSpeed {
  choice: SpeedChoice
  outcome: SpeedOutcome
  /** The tip the split shows; unset while inactive, or until the quote, schedule and note read. */
  proverTip?: bigint
  /** What the split shows, as a tap commits it; undefined while `proverTip` is. */
  decision?: SpeedDecision
  /**
   * The decision for a tap that goes ahead before the quote answers: Standard with no tip, and the
   * choice moves to Standard so a later quote keeps it. Inactive, there is none.
   */
  settle: () => SpeedDecision | undefined
}

/** The speed choice a split surface shows while `active`, and the decision a tap commits. */
export function useRegistrationSpeed({
  active,
  noteAmount,
  schedule,
  withdrawalFee,
  initialSpeed,
}: {
  active: boolean
  noteAmount?: bigint
  schedule?: RegistrationSchedule
  /** The source executor's withdrawal fee. */
  withdrawalFee?: bigint
  initialSpeed?: WithdrawalSpeed
}): RegistrationSpeed {
  const choice = useSpeedChoice({
    active,
    amount: noteAmount,
    initialSpeed,
    answerWithinMs: REGISTRATION_OFFER_TIMEOUT_MS,
  })
  const offer = choice.offer
  const covers =
    offer && noteAmount !== undefined && schedule && withdrawalFee !== undefined
      ? goldenTicketCoverage(noteAmount, schedule, offer.proverTip, withdrawalFee).covers
      : undefined
  const outcome = useSpeedOutcome(choice, covers, REGISTRATION_TIP_BLOCKED_COPY)
  const [picks, setPicks] = useState(0)
  const unread = !schedule || choice.loading || (offer !== undefined && noteAmount === undefined)
  const tip = active && !unread ? outcome.proverTip : undefined
  const decision =
    tip === undefined ? undefined : { tip, speed: choice.speed, withdrawalFee, picks }
  const settle = (): SpeedDecision | undefined => {
    if (decision || !active) return decision
    choice.setSpeed("standard")
    return { tip: 0n, speed: "standard", withdrawalFee, picks }
  }
  // The picker's changes count as the user's; the fallback to Standard does not.
  const picked = {
    ...choice,
    setSpeed(speed: WithdrawalSpeed) {
      setPicks((n) => n + 1)
      choice.setSpeed(speed)
    },
  }
  return { choice: picked, outcome, proverTip: tip, decision, settle }
}
