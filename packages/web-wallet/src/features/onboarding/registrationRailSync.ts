/**
 * The deposit rail's record for a registration SIPA, kept in step with what the wallet knows before
 * the rail's own scan does. The scan learns of a deposit from the Sweep log; the funds are seen well
 * before that, by the address watch or the detection tick, and the sweep by the tick or a manual
 * sweep. Written here, the deposit flow's own surfaces carry the registration from the moment funds
 * land: the bell's live row, the activity row and its detail.
 */
import { formatUnits, type Address } from "viem"
import { tokenDecimalsForNetwork } from "@obsidion/core/constants"
import type { SIPADepositPhase } from "@obsidion/core/types"
import {
  SIPADepositStore,
  isUnfundedSipaDeposit,
  type PendingRegistrationRecord,
} from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { loadRegistrationTerms } from "./registrationTerms"

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

/** Funds seen at a registration SIPA, written only onto a rail record that still shows none. */
export async function noteRegistrationDepositSeen(
  sipaAddress: string,
  amount: bigint,
): Promise<void> {
  if (amount <= 0n) return
  await SIPADepositStore.get(webStorage).update(sipaAddress as Address, (deposit) => {
    if (!isUnfundedSipaDeposit(deposit)) return null
    const decimals = deposit.tokenDecimals ?? tokenDecimalsForNetwork(getConfig().network)
    return {
      phase: deposit.phase,
      reorgEpoch: deposit.reorgEpoch,
      amount: formatUnits(amount, decimals),
    }
  })
}

/**
 * Bring the rail in step with the registration records: a funded record's deposit is on the rail
 * at the amount the address watch stamped, a swept one's is sweeping with its hash.
 */
export async function syncRegistrationRail(
  records: readonly PendingRegistrationRecord[],
): Promise<void> {
  const rail = SIPADepositStore.get(webStorage)
  for (const record of records) {
    if (swept(record)) {
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
      continue
    }
    if (record.fundedAt === undefined) continue
    const stamped = loadRegistrationTerms(record.account, record.tag)?.depositAmount
    if (stamped) await noteRegistrationDepositSeen(record.sipaAddress, BigInt(stamped))
  }
}
