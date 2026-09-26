/**
 * Pure resolver for the withdrawal boot wiring, shared by every wallet front end.
 *
 * The mapping from the oxide env tuple to the `WithdrawalPortalContext` is the single most
 * critical invariant in the withdrawal path: `withdrawalId = sha256(burnTxHash ‖
 * computeWithdrawMessageHash(portalContext, …))`, and the message hash binds
 * `l2Portal`/`l1Portal`/`rollupVersion`/`l1ChainId`. A wrong `l2Portal` (it must be
 * `tuple.l2Token`, NOT `tuple.portal`) or chain id yields a `withdrawalId` that
 * `$isWithdrawalSpent` never flips true for, so every withdrawal would hang at `finalizing_l1`
 * forever — silently. This resolver + its test pin the mapping so a future edit can't regress it.
 */

import type { OxideEnvTuple } from "@obsidion/core/types"
import type { WithdrawalPortalContext } from "@obsidion/sdk"
import type { Hex } from "viem"

export interface WithdrawalWiring {
  /** L1 TEE portal (`$isWithdrawalSpent` + `WithdrawalOrRefund` live here; every release is
   *  submitted to it). */
  portal: Hex
  /** The executor every wallet burn settles into; self-finalize rebuilds the burn's payload for it. */
  plainWithdrawalExecutor: Hex
  /**
   * The subsidy a self-finalize claims for its submitter. Outside the null gate below: tracking
   * works without it.
   */
  withdrawalSubsidy?: Hex
  /** Portal context for `withdrawalId` derivation. */
  portalContext: WithdrawalPortalContext
}

/**
 * Resolve the reader inputs + portal context from a tuple, or `null` when the tuple lacks the
 * oxide-rails deployment coordinates (a not-yet-applied manifest, or one that predates the plain
 * withdrawal executor) — withdrawals are an oxide-rails feature, so wiring is skipped there rather
 * than derived against empty coords.
 */
export function resolveWithdrawalWiring(
  tuple: OxideEnvTuple,
  l1ChainId: bigint,
): WithdrawalWiring | null {
  if (
    !tuple.portal ||
    !tuple.plainWithdrawalExecutor ||
    !tuple.l2Token ||
    !/^\d+$/.test(tuple.rollupVersion ?? "")
  ) {
    return null
  }
  return {
    portal: tuple.portal as Hex,
    plainWithdrawalExecutor: tuple.plainWithdrawalExecutor as Hex,
    withdrawalSubsidy: tuple.withdrawalSubsidy as Hex | undefined,
    portalContext: {
      l1Portal: tuple.portal as Hex,
      // Load-bearing: the L2 oxide-token address, NOT the L1 portal.
      l2Portal: tuple.l2Token,
      rollupVersion: BigInt(tuple.rollupVersion),
      l1ChainId,
    },
  }
}
