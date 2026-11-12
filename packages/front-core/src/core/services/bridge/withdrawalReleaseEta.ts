/**
 * How long a sent withdrawal still takes to release on L1: the burn's standard ETA from its
 * landing, then the relayer's pickup. Time remaining where the burn has landed, the typical
 * duration while it is still being mined.
 */
import { SWEEP_PICKUP_SECONDS } from "../deposits/depositArrival"
import type { WithdrawalRecord } from "./types"

export interface WithdrawalReleaseEta {
  seconds: number
  /** True where `seconds` counts down from a known start; false for a typical duration. */
  remaining: boolean
}

const remainingOr = (seconds: number): WithdrawalReleaseEta | undefined =>
  seconds > 0 ? { seconds, remaining: true } : undefined

export function withdrawalReleaseEta(
  record: Pick<
    WithdrawalRecord,
    "phase" | "l2TxHash" | "startTime" | "phaseEnteredAt" | "minedAt" | "reorgEpoch"
  >,
  /** Seconds from a burn landing at `landedAtSeconds` until its release is finalizable on L1. */
  releaseSeconds: (landedAtSeconds: number) => number,
  nowMs: number,
): WithdrawalReleaseEta | undefined {
  const now = nowMs / 1000
  switch (record.phase) {
    case "submitting":
      return record.l2TxHash
        ? { seconds: releaseSeconds(now) + SWEEP_PICKUP_SECONDS, remaining: false }
        : undefined
    case "l2_mined":
    case "awaiting_proven": {
      // After a reorg the burn lands again, at the phase's re-entry; `minedAt` keeps its first.
      const landedMs = record.reorgEpoch ? record.phaseEnteredAt : record.minedAt
      const landed = (landedMs ?? record.phaseEnteredAt ?? record.startTime) / 1000
      return remainingOr(landed + releaseSeconds(landed) + SWEEP_PICKUP_SECONDS - now)
    }
    case "finalizing_l1": {
      // Proven: the relayer's release is one pickup away.
      const proven = (record.phaseEnteredAt ?? record.startTime) / 1000
      return remainingOr(proven + SWEEP_PICKUP_SECONDS - now)
    }
    default:
      // Released, or never will be.
      return undefined
  }
}
