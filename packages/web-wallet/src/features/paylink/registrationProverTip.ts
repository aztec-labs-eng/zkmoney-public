/**
 * The speed a ticket registration's burn takes. Registration needs no tip, so Faster, the default,
 * tips only when that buys a faster withdrawal and the note still covers the burn with it. A surface
 * showing the split commits the choice, and the claim burns what was committed. A signup that goes
 * ahead before the quote answers commits Standard.
 */
import { useEffect, useRef } from "react"
import type { RegistrationSchedule } from "@obsidion/core/types"
import { goldenTicketCoverage, type WithdrawalSpeedupNode } from "@obsidion/front-core"
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
  /**
   * Commits Standard with no tip when nothing is committed yet, for a surface that goes ahead
   * before the quote answers. The choice moves to Standard too, so a later quote keeps it.
   */
  settle: () => void
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
  withdrawalFee,
  initialSpeed,
  onCommit,
  commitKey,
  load,
}: {
  active: boolean
  node?: WithdrawalSpeedupNode
  noteAmount?: bigint
  schedule?: RegistrationSchedule
  /** The source executor's withdrawal fee. */
  withdrawalFee?: bigint
  initialSpeed?: WithdrawalSpeed
  onCommit: (tip: bigint, speed: WithdrawalSpeed) => void
  commitKey?: string
  load?: LoadFasterWithdrawal
}): RegistrationSpeed {
  const choice = useSpeedChoice({
    active,
    node,
    amount: noteAmount,
    initialSpeed,
    answerWithinMs: REGISTRATION_OFFER_TIMEOUT_MS,
    load,
  })
  const offer = choice.offer
  const covers =
    offer && noteAmount !== undefined && schedule && withdrawalFee !== undefined
      ? goldenTicketCoverage(noteAmount, schedule, offer.proverTip, withdrawalFee).covers
      : undefined
  const outcome = useSpeedOutcome(choice, covers, REGISTRATION_TIP_BLOCKED_COPY)
  const unread = !schedule || choice.loading || (offer !== undefined && noteAmount === undefined)
  const tip = unread ? undefined : outcome.proverTip
  const committed = useRef<bigint>(undefined)
  useEffect(() => {
    if (!active || tip === undefined) return
    committed.current = tip
    onCommit(tip, choice.speed)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- commits each decision once per target
  }, [active, tip, choice.speed, commitKey])
  const settle = () => {
    if (!active || tip !== undefined) return
    choice.setSpeed("standard")
    committed.current = 0n
    onCommit(0n, "standard")
  }
  return { choice, outcome, proverTip: active ? tip : committed.current, settle }
}
