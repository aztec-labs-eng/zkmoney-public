/**
 * Pure resolver for the withdrawal boot wiring, shared by every wallet front end.
 *
 * `withdrawalId = sha256(burnTxHash ‖ messageHash)`, where the message hashes are the ones the burn's
 * DA attests under the L2 token. A wrong `l2Token` (it must be `tuple.l2Token`, NOT `tuple.portal`)
 * finds no message hash, so every withdrawal would hang before `finalizing_l1`. This resolver + its
 * test pin the mapping so a future edit can't regress it.
 */

import type { OxideEnvTuple } from "@obsidion/core/types"
import type { Hex } from "viem"

export interface WithdrawalWiring {
  /** L1 TEE portal (`$isWithdrawalSpent` + `WithdrawalOrRefund` live here; every release is
   *  submitted to it). */
  portal: Hex
  /** The L2 token whose burns the tracker reads. */
  l2Token: string
  /** The executor the bridge lists: what a new burn pays. A record keeps its own burn's. */
  plainWithdrawalExecutor: Hex
}

/**
 * Resolve the reader inputs from a tuple, or `null` when the tuple lacks the oxide-rails deployment
 * coordinates (a not-yet-applied manifest, or one that predates the plain withdrawal executor) —
 * withdrawals are an oxide-rails feature, so wiring is skipped there rather than derived against
 * empty coords.
 */
export function resolveWithdrawalWiring(tuple: OxideEnvTuple): WithdrawalWiring | null {
  if (!tuple.portal || !tuple.plainWithdrawalExecutor || !tuple.l2Token) {
    return null
  }
  return {
    portal: tuple.portal as Hex,
    // Load-bearing: the L2 oxide-token address, NOT the L1 portal.
    l2Token: tuple.l2Token,
    plainWithdrawalExecutor: tuple.plainWithdrawalExecutor as Hex,
  }
}
