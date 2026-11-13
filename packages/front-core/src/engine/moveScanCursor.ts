/** The L1 blocks one deposit search covers: one `getLogs` per move per pass, in provider limits. */
export const MOVE_SCAN_SPAN = 10_000n
/**
 * Blocks behind the head a pass searches again: a reorg or a lagging replica can move a deposit.
 */
export const MOVE_SCAN_MARGIN = 64n

/** The blocks one pass searches from `from`, or none while `from` is past the head. */
export function scanRange(from: bigint, head: bigint): { from: bigint; to: bigint } | undefined {
  const last = from + MOVE_SCAN_SPAN - 1n
  const to = head < last ? head : last
  return from <= to ? { from, to } : undefined
}

/** The blocks the next search of a move covers: on from its cursor, or from `scanFrom` with none. */
export function moveScanRange(
  move: { scanFrom: bigint; scannedTo?: bigint },
  head: bigint,
): { from: bigint; to: bigint } | undefined {
  return scanRange((move.scannedTo ?? move.scanFrom - 1n) + 1n, head)
}

/**
 * Where a search that found nothing in `scanFrom..to` leaves the cursor: the margin behind the head
 * is searched again, and nothing is recorded while the search has not passed `scanFrom`.
 */
export function scannedTo(scanFrom: bigint, to: bigint, head: bigint): bigint | undefined {
  const edge = head - MOVE_SCAN_MARGIN
  const settled = to < edge ? to : edge
  return settled >= scanFrom ? settled : undefined
}
