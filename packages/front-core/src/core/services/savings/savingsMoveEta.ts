/**
 * How long a Savings move still takes, from the legs the wallet already times: the burn's release
 * (the withdrawal flow's standard ETA from its landing), then the relayer's pickup of the escrow and
 * its deposit reaching L2 and the claim (the deposit arrival chain, with the escrow run as the
 * sweep). Time remaining where a leg's start is on the record, the typical duration where it is not.
 */
import type { SavingsMove } from "../../../oxide/savingsMoves"
import type { WithdrawalRecord } from "../bridge/types"
import { SWEEP_PICKUP_SECONDS, depositArrivalSeconds } from "../deposits/depositArrival"

export interface SavingsMoveTiming {
  /** The rollup's slot grid and the Inbox's checkpoint lag. */
  grid: { l1GenesisTime: number; slotDuration: number; inboxLag: number }
  /** Seconds from a burn landing at `landedAtSeconds` until its release is finalizable on L1. */
  releaseSeconds: (landedAtSeconds: number) => number
}

export interface SavingsMoveEta {
  seconds: number
  /** True where `seconds` counts down from a leg whose start is known; false for a typical duration. */
  remaining: boolean
}

const remainingOr = (seconds: number): SavingsMoveEta | undefined =>
  seconds > 0 ? { seconds, remaining: true } : undefined

export function savingsMoveEta(
  move: Pick<SavingsMove, "deposit" | "recovered"> & { startTime: number },
  burn: Pick<WithdrawalRecord, "phase" | "startTime" | "phaseEnteredAt" | "endTime"> | undefined,
  timing: SavingsMoveTiming,
  nowMs: number,
): SavingsMoveEta | undefined {
  if (move.deposit?.claimed || move.recovered || burn?.phase === "failed") return undefined
  const now = nowMs / 1000
  const arrival = (fromSeconds: number, sweepSeconds?: number) =>
    depositArrivalSeconds({ nowSeconds: fromSeconds, ...timing.grid, sweepSeconds })
  const entered = (burn?.phaseEnteredAt ?? burn?.startTime ?? move.startTime) / 1000
  switch (burn?.phase) {
    case "submitting": {
      // Still proving on the device: the whole journey from a landing now.
      const release = timing.releaseSeconds(now)
      return { seconds: release + arrival(now + release), remaining: false }
    }
    case "l2_mined":
    case "awaiting_proven": {
      const releaseAt = entered + timing.releaseSeconds(entered)
      return remainingOr(releaseAt + arrival(releaseAt) - now)
    }
    case "finalizing_l1": {
      // Proven: the relayer's release is one pickup away.
      const releaseAt = entered + SWEEP_PICKUP_SECONDS
      return remainingOr(releaseAt + arrival(releaseAt) - now)
    }
    default: {
      // Released. A found deposit has had its pickup; what is left is its message and the claim.
      if (move.deposit) return { seconds: arrival(now, 0), remaining: false }
      const releasedAt = (burn?.endTime ?? burn?.phaseEnteredAt ?? move.startTime) / 1000
      return remainingOr(releasedAt + arrival(releasedAt) - now)
    }
  }
}
