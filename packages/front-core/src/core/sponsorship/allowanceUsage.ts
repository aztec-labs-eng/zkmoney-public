import type { ClaimFpcSubscriptionNote } from "@obsidion/sdk"

/** The uses the current allowance has spent, by what spent them. */
export interface AllowanceUsage {
  /** Batches the user started: sends, payment links, withdrawals. */
  yours: number
  /** Batches that published a deposit address, most of them in the background. */
  depositAddresses: number
}

/** The notes of the allowance held now. A renewal stamps a later `refilledAt` on every note after it. */
export function currentAllowanceNotes(
  notes: readonly ClaimFpcSubscriptionNote[],
): ClaimFpcSubscriptionNote[] {
  if (notes.length === 0) return []
  const current = notes.reduce((max, note) => (note.refilledAt > max ? note.refilledAt : max), 0n)
  return notes.filter((note) => note.refilledAt === current)
}

/**
 * Each note's uses fall from the note before it (`maxTx` before the first), and the drop belongs to
 * the tx that wrote it: one batch can spend two, such as a payment link that gifts a voucher.
 */
export function allowanceUsage(
  notes: readonly ClaimFpcSubscriptionNote[],
  maxTx: number,
  broadcastTxs: ReadonlySet<string>,
): AllowanceUsage {
  const usage: AllowanceUsage = { yours: 0, depositAddresses: 0 }
  let previous = maxTx
  for (const note of currentAllowanceNotes(notes).sort((a, b) => b.uses - a.uses)) {
    const spent = previous - note.uses
    previous = note.uses
    if (broadcastTxs.has(note.txHash)) usage.depositAddresses += spent
    else usage.yours += spent
  }
  return usage
}
