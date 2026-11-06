/**
 * The token's duplicate signals from `store_deposit`: "deposit already stored" (the capsule holds this inbox index)
 * and "deposit already spent" (its nullifier exists: a prior session stored and spent it). Both mean the deposit needs
 * no further claim work; retrying forever would wedge every later claim behind it.
 */
export function isAlreadyClaimedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes("deposit already stored") || message.includes("deposit already spent")
}
