/**
 * The speed a ticket registration's burn takes. Registration needs no tip, so Faster, the default,
 * tips only when that buys a faster withdrawal and the note still covers the burn with it. A surface
 * showing the split commits the choice, and the claim burns what was committed.
 */
import { useEffect, useRef } from "react"
import type { RegistrationSchedule } from "@obsidion/core/types"
import {
  goldenTicketCoverage,
  type GoldenTicketCuts,
  type WithdrawalSpeedupNode,
} from "@obsidion/front-core"
import {
  useSpeedChoice,
  useSpeedOutcome,
  type SpeedChoice,
  type SpeedOutcome,
} from "../withdraw/speedChoice"
import type { LoadFasterWithdrawal } from "../withdraw/useFasterWithdrawal"
import type { WithdrawalSpeed } from "../withdraw/WithdrawalSpeedPicker"

/** A registration waits this long for its first quote, then goes ahead without a tip. */
export const REGISTRATION_OFFER_TIMEOUT_MS = 15_000

export const REGISTRATION_TIP_BLOCKED_COPY = "The payment can't cover the tip"

export interface RegistrationSpeed {
  choice: SpeedChoice
  outcome: SpeedOutcome
  /** The tip the split commits; undefined while the quote, the schedule or the note are unread. */
  proverTip?: bigint
}

/**
 * The speed choice a split surface shows and commits while `active`. Inactive, the tip is the last
 * one committed. A new `commitKey` (the target `onCommit` writes to) commits the same choice again.
 */
export function useRegistrationSpeed({
  active,
  node,
  noteAmount,
  schedule,
  cuts,
  initialSpeed = "faster",
  onCommit,
  commitKey,
  load,
}: {
  active: boolean
  node?: WithdrawalSpeedupNode
  noteAmount?: bigint
  schedule?: RegistrationSchedule
  cuts?: GoldenTicketCuts
  initialSpeed?: WithdrawalSpeed
  onCommit: (tip: bigint, speed: WithdrawalSpeed) => void
  commitKey?: string
  load?: LoadFasterWithdrawal
}): RegistrationSpeed {
  const choice = useSpeedChoice({
    active,
    node,
    initialSpeed,
    answerWithinMs: REGISTRATION_OFFER_TIMEOUT_MS,
    load,
  })
  const offer = choice.offer
  const covers =
    offer && noteAmount !== undefined && schedule && cuts
      ? goldenTicketCoverage(noteAmount, schedule, cuts, offer.proverTip).covers
      : undefined
  const outcome = useSpeedOutcome(choice, covers, REGISTRATION_TIP_BLOCKED_COPY)
  const unread =
    !schedule || !cuts || choice.loading || (offer !== undefined && noteAmount === undefined)
  const tip = unread ? undefined : outcome.proverTip
  const committed = useRef<bigint>(undefined)
  useEffect(() => {
    if (!active || tip === undefined) return
    committed.current = tip
    onCommit(tip, choice.speed)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- commits each decision once per target
  }, [active, tip, choice.speed, commitKey])
  return { choice, outcome, proverTip: active ? tip : committed.current }
}
