import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import type { BackupFundingSplit } from "@obsidion/front-core"
import { toCents } from "../../ui/format"

/** What the add takes from the balance, in whole cents. */
export interface AddCost {
  fee: bigint
  /** Comes back once the backup is active. */
  hold: bigint
  total: bigint
}

/**
 * The add's figures in whole cents, each rounded once: the total up, so paying or depositing it is
 * always enough, and the hold down, so it never promises more back. The fee is what is left, so
 * the three add up.
 */
export function addCost({ sent, credited }: BackupFundingSplit): AddCost {
  const total = toCents(sent, DEFAULT_DECIMALS, true)
  const hold = toCents(credited, DEFAULT_DECIMALS, false)
  return { fee: total - hold, hold, total }
}

/**
 * A fee in whole cents as two parts that add up to it: `steady`, rounded up, and the rest. The rest
 * takes the rounding, so the part the tip does not move reads the same at either speed.
 */
export function feeSplit(fee: bigint, steady: bigint): [rest: bigint, steady: bigint] {
  const part = toCents(steady, DEFAULT_DECIMALS, true)
  return [fee - part, part]
}
