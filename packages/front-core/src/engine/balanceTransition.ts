import type { BalanceEntry } from "./balances"

/**
 * A stored read after `next` is written: unchanged when it was read at an older anchor than the
 * stored one, so a read pinned behind an in-flight send never regresses a newer value.
 */
export function balanceTransition(
  current: BalanceEntry | undefined,
  next: BalanceEntry,
): BalanceEntry | undefined {
  const older =
    next.anchor !== undefined && current?.anchor !== undefined && next.anchor < current.anchor
  return older ? undefined : next
}
