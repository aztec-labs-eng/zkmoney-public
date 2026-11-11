import type { SipaDeposit } from "../../../engine/sipaDeposits"

/** How long a `sweeping` record has to sit before it offers recovery. */
export const STUCK_SWEEP_MS = 4 * 60_000

/**
 * A `sweeping` or `broadcast` record nothing has moved for `STUCK_SWEEP_MS` — the state the exits
 * are offered from. A `broadcast` record this old means no relayer ever acknowledged the deposit
 * (e.g. it was funded on a since-retired deployment); the funding read in each exit still gates an
 * unfunded one. `sweepTxHash` here is a confirmed self-sweep: the funds are already in the portal
 * and the next sync scan advances the record, so it is waiting, not stuck.
 *
 * The clock runs from the wallet's last ask to publish the SIPA again, else from `startTime`. A
 * payment to an already-swept address waits for that ask before any relayer can sweep it, and its
 * `startTime` is its L1 block time: hours back when the wallet finds it late.
 */
export function isStuckSweep(
  record: Pick<SipaDeposit, "phase" | "startTime" | "sweepTxHash" | "republishAskedAt">,
  now: number = Date.now(),
): boolean {
  return (
    (record.phase === "sweeping" || record.phase === "broadcast") &&
    !record.sweepTxHash &&
    now - (record.republishAskedAt ?? record.startTime) >= STUCK_SWEEP_MS
  )
}
