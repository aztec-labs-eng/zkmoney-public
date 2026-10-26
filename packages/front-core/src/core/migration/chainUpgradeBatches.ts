import { depositAmounts } from "../services/deposits/depositAmounts"
import {
  isUnfundedSipaDeposit,
  type SIPADepositRecord,
} from "../services/deposits/SIPADepositStore"
import type { UpgradeBatchItem } from "./upgradeActivity"

/**
 * The run a device without an upgrade's records lists the direct deposits into `portal` under: each
 * destination is an upgrade of its own, as Main and Savings are. The portal is the key's second
 * segment, as in a saved run's key.
 */
export const chainUpgradeRun = (portal: string) => `chain-upgrade/${portal.toLowerCase()}`

/**
 * The portal a direct deposit lands in: its deposit's once seen, else its announcement's. A record
 * that names no portal groups by its asset.
 */
function destinationOf(record: SIPADepositRecord): string {
  return (
    record.sweeps?.at(-1)?.portal ??
    record.pendingSweeps?.[0]?.portal ??
    record.direct?.portal ??
    record.rowToken ??
    record.tokenAddress ??
    ""
  )
}

/**
 * An upgrade's batches read off its deposits alone, for a device that holds none of the run's
 * records. Only an upgrade's migration executor deposits under a commitment with no SIPA, and its
 * L2 announcement records the deposit on every device of the account, so each direct deposit is a
 * batch of the run of the portal it lands in. `known` holds the deposits this device's own runs
 * pay; those stay theirs.
 */
export function chainUpgradeBatches(
  records: readonly SIPADepositRecord[],
  known: ReadonlySet<string>,
): UpgradeBatchItem[] {
  const runs = new Map<string, number>()
  return records
    .filter((record) => record.direct && !known.has(record.sipaAddress.toLowerCase()))
    .sort((a, b) => a.startTime - b.startTime)
    .map((record) => {
      const run = chainUpgradeRun(destinationOf(record))
      const index = runs.get(run) ?? 0
      runs.set(run, index + 1)
      return {
        run,
        id: `remaining-${index}`,
        recipient: record.sipaAddress,
        amount:
          record.direct!.expected ??
          String(depositAmounts(record, record.tokenDecimals).grossAtomic),
        // Its announcement rides the refund's transaction, so the refund was sent.
        state: isUnfundedSipaDeposit(record) ? "sent" : "received",
        approved: true,
        startTime: record.startTime,
        inferred: true,
      }
    })
}
