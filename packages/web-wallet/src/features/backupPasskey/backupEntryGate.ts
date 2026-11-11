/** What the backup entry waits on before it shows its open links. */
export interface EntryReads<L> {
  links: L | "unreadable" | undefined
  /** Whether the Savings moves replay rebuilt the burns; undefined before it ends. */
  replayed: boolean | undefined
  /** Every rebuilt Savings burn has its move. */
  adopted: boolean
  savingsMoves: { loaded: boolean; failed: boolean }
  withdrawalsHydrated: boolean
  holdingsPending: boolean
  /** The device reached its first balance and replayed its moves. */
  synced: boolean
}

/**
 * The entry's open links once every read is in and every Savings burn has its move: unreadable
 * once one failed, the Savings moves replay included, since a move it missed would land after the
 * switch, unclaimed; checking while one is unread.
 */
export function gatedLinks<L extends object>(reads: EntryReads<L>): L | "checking" | "unreadable" {
  const { links, replayed, savingsMoves } = reads
  if (links === "unreadable" || replayed === false || savingsMoves.failed) return "unreadable"
  const loaded =
    reads.withdrawalsHydrated &&
    !reads.holdingsPending &&
    savingsMoves.loaded &&
    replayed !== undefined &&
    reads.adopted
  return reads.synced && loaded && links !== undefined ? links : "checking"
}
