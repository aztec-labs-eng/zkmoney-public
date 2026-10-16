import type { Address } from "viem"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { IdentityGeneration } from "./oxideIdentityGeneration"

/**
 * Not a real ClaimFPC — a retired-rollup generation never reads one live, so this placeholder is
 * never meant to resolve. Kept well-formed and traceable (the retired deployment's own L1 portal,
 * zero-extended) so a future bug that lets it reach a sponsorship consumer fails on an obviously
 * synthetic address instead of a malformed string.
 */
function syntheticFpcAddress(tuple: OxideEnvTuple): string {
  return `0x${tuple.portal.replace(/^0x/i, "").padStart(64, "0")}`
}

/**
 * One sign-in admission candidate per retired-rollup manifest entry, built from its own static
 * `accountFactory`/`namePortal` fields. No live ClaimFPC read: the L1 registries admission checks
 * against persist across a rollup cutover, so this needs no node or PXE connection to the retired
 * rollup at all.
 */
export function retiredIdentityGenerations(
  retired: readonly OxideEnvTuple[],
): IdentityGeneration[] {
  return retired.flatMap((tuple) => {
    if (!tuple.accountFactory || !tuple.namePortal) return []
    return [
      {
        fpcAddress: syntheticFpcAddress(tuple),
        accountFactory: tuple.accountFactory as Address,
        namePortal: tuple.namePortal as Address,
        rollupVersion: tuple.rollupVersion,
      },
    ]
  })
}
