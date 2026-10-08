import type { ClaimFpcAllowance } from "@obsidion/sdk"

/**
 * What a sponsored-transaction allowance read can show. A stored zero on a rail that renews is
 * `renewal-unknown`: the read cannot tell whether the next batch starts a new allowance, so it must
 * not block that batch.
 */
export type SponsoredAllowanceState =
  | { kind: "not-subscribed"; maxTx: number; renews: boolean }
  | { kind: "available"; available: number; renews: boolean }
  | { kind: "renewal-unknown"; maxTx: number }
  | { kind: "does-not-renew" }

export function deriveAllowanceState(allowance: ClaimFpcAllowance): SponsoredAllowanceState {
  const renews = allowance.refillPeriod > 0
  if (!allowance.subscribed) return { kind: "not-subscribed", maxTx: allowance.maxTx, renews }
  if (allowance.uses > 0) return { kind: "available", available: allowance.uses, renews }
  return renews ? { kind: "renewal-unknown", maxTx: allowance.maxTx } : { kind: "does-not-renew" }
}

/**
 * Whether the allowance pays for `uses` more sponsored batches. A subscribe spends the first use of
 * the allowance it opens. A stored zero counts as none, because the read cannot confirm a renewal.
 */
export function allowanceCovers(state: SponsoredAllowanceState, uses: number): boolean {
  switch (state.kind) {
    case "not-subscribed":
      return state.maxTx >= uses
    case "available":
      return state.available >= uses
    default:
      return false
  }
}

/** Whether the read proves the next sponsored batch on this rail fails for want of a use. */
export function allowanceBlocksSponsoredAction(state: SponsoredAllowanceState): boolean {
  return state.kind === "does-not-renew"
}
