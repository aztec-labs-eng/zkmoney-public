/** What the backup entry waits on before it shows its open links. */
export interface EntryReads<L> {
  links: L | "unreadable" | undefined
  /** Every Sky burn has its move. */
  adopted: boolean
  moves: { loaded: boolean; failed: boolean }
  withdrawalsHydrated: boolean
  holdingsPending: boolean
  /** The device reached its first balance and replayed its moves. */
  synced: boolean
}

/**
 * The entry's open links once every read is in and every Sky burn has its move, since a move the
 * replay missed would land after the switch, unclaimed: unreadable once a read failed; checking
 * while one is unread.
 */
export function gatedLinks<L extends object>(reads: EntryReads<L>): L | "checking" | "unreadable" {
  const { links, moves } = reads
  if (links === "unreadable" || moves.failed) return "unreadable"
  const loaded =
    reads.withdrawalsHydrated && !reads.holdingsPending && moves.loaded && reads.adopted
  return reads.synced && loaded && links !== undefined ? links : "checking"
}
