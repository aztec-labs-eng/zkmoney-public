import type { SIPADepositRecord } from "./SIPADepositStore"

/** How long a `sweeping` record has to sit before it offers recovery. Anchored on `startTime`. */
export const STUCK_SWEEP_MS = 4 * 60_000

/**
 * A `sweeping` or `broadcast` record nothing has moved for `STUCK_SWEEP_MS` — the state the exits
 * are offered from. A `broadcast` record this old means no relayer ever acknowledged the deposit
 * (e.g. it was funded on a since-retired deployment); the funding read in each exit still gates an
 * unfunded one. `sweepTxHash` here is a confirmed self-sweep: the funds are already in the portal
 * and the next sync scan advances the record, so it is waiting, not stuck.
 */
export function isStuckSweep(
  record: Pick<SIPADepositRecord, "phase" | "startTime" | "sweepTxHash">,
  now: number = Date.now(),
): boolean {
  return (
    (record.phase === "sweeping" || record.phase === "broadcast") &&
    !record.sweepTxHash &&
    now - record.startTime >= STUCK_SWEEP_MS
  )
}
