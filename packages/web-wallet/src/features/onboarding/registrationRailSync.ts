/**
 * The deposit rail's record for a registration SIPA, kept in step with what the wallet knows before
 * the rail's own scan does: the sweep is known first by the detection tick or a manual sweep. Written
 * here, the deposit flow's own surfaces carry the registration from then: the bell's live row, the
 * activity row and its detail.
 */
import type { Address } from "viem"
import type { SIPADepositPhase } from "@obsidion/core/types"
import { SIPADepositStore, type PendingRegistrationRecord } from "@obsidion/front-core"
import { webStorage } from "../../platform/storage/WebStorageAdapter"

/**
 * What the rail should say once a sweep is known. Phases past the sweep, and the terminal ones,
 * already know better than the receipt does.
 */
export function sweptPhase(phase: SIPADepositPhase): SIPADepositPhase {
  const beforeSweep: readonly SIPADepositPhase[] = ["resolved", "funding", "funded", "broadcast"]
  return beforeSweep.includes(phase) ? "sweeping" : phase
}

const swept = (record: PendingRegistrationRecord) =>
  record.sweptAt !== undefined || record.sweepTxHash !== undefined

/**
 * Bring the rail in step with the registration records: a swept one's deposit is sweeping with its
 * hash. Funds the rail observes itself.
 */
export async function syncRegistrationRail(
  records: readonly PendingRegistrationRecord[],
): Promise<void> {
  const rail = SIPADepositStore.get(webStorage)
  for (const record of records) {
    if (swept(record))
      await rail.update(record.sipaAddress as Address, (deposit) => {
        const phase = sweptPhase(deposit.phase)
        const hash = record.sweepTxHash !== undefined && !deposit.sweepTxHash
        if (phase === deposit.phase && !hash) return null
        return {
          phase,
          reorgEpoch: deposit.reorgEpoch,
          ...(hash ? { sweepTxHash: record.sweepTxHash } : {}),
        }
      })
  }
}
