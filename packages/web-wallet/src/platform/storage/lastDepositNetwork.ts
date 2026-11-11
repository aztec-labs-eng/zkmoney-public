import { bestEffort } from "@obsidion/core/errors"
import type { Database } from "@obsidion/front-core"
import { writeDeviceKeys } from "./deviceKeys"

/** The network this browser last picked to deposit from, preselected next time. */
export function lastDepositNetwork(saved: string | null): number | undefined {
  const id = Number(saved ?? undefined)
  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

/** A pick that cannot be saved is logged; the picker then starts blank next time. */
export const rememberDepositNetwork = (db: Database, chainId: number) =>
  void bestEffort("unknown", writeDeviceKeys(db, { lastDepositNetwork: String(chainId) }))
