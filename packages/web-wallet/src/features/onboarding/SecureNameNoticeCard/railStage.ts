import {
  isStuckSweep,
  selectSipaDeposit,
  sipaReasonShown,
  type PendingRegistrationRecord,
  type RecordSet,
  type SipaDeposit,
  type SipaProcessingState,
} from "@obsidion/front-core"

/**
 * The open registration's deposit on the rail at `now`, and why its sweep waits when the bell says
 * so. A stated reason or a stuck sweep has no known end (`openEnded`).
 */
export function railStage(
  record: PendingRegistrationRecord | null,
  deposits: RecordSet<SipaDeposit>,
  stateFor: (sipaAddress: string) => SipaProcessingState | undefined,
  now: number,
) {
  const deposit = record ? selectSipaDeposit(deposits, record.sipaAddress) ?? null : null
  const processing = deposit ? stateFor(deposit.sipaAddress) : undefined
  const shown = deposit && sipaReasonShown(processing, deposit) ? processing : undefined
  const stuck = deposit !== null && isStuckSweep(deposit, now)
  return { deposit, shown, openEnded: shown !== undefined || stuck }
}

export type RailStage = ReturnType<typeof railStage>
