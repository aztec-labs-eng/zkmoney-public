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
 * The add's figures in whole cents, each rounded once: the hold down, so it never promises more
 * back, and the total up, so with a hold it never reads less than leaves the balance. The fee is
 * what is left, so the three add up. A credit under a cent shows no hold, and the total leaves it
 * out: the one unit a fee-only add credits would otherwise round its fee up a cent.
 */
export function addCost({ sent, credited }: BackupFundingSplit): AddCost {
  const hold = toCents(credited, DEFAULT_DECIMALS, false)
  const total = toCents(hold > 0n ? sent : sent - credited, DEFAULT_DECIMALS, true)
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
