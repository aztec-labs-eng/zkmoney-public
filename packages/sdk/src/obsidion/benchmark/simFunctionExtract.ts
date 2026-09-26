// Sim-side per-function extractor (docs/plans/2026-06-04-001). Pure.
//
// Maps upstream `@aztec/pxe` `SimulationTimings` (returned on
// `TxSimulationResult.stats`) to the benchmark's per-function sim breakdown.
// For each private function executed during a simulation, carries its witgen ms
// and the aggregate oracle-resolution ms.
//
// PRIVACY: function names are gated through a first-party allowlist
// (`normalizeFunctionName`) BEFORE they leave this module — a non-allowlisted
// name is redacted to a single aggregated `"<non-allowlisted>"` bucket. Oracle
// names and `nodeRPCCalls` are NEVER read (only the numeric oracle times are
// summed). This is the in-code privacy gate; the allowlist Set below is the
// reviewable source of truth (asserted in the test against a real fixture).

import type { SimulationTimings } from "@aztec/stdlib/tx"
import type { SimFunctionTiming } from "@obsidion/core/types"

/** Redaction placeholder for any non-allowlisted function name. */
export const NON_ALLOWLISTED = "<non-allowlisted>"

/**
 * First-party `artifact.name:fn.name` debug names allowed verbatim. EXACT
 * full-name match only (never bare/suffix) so a future partner contract reusing
 * a generic name like `claim` cannot leak. Grounded in the Noir contracts under
 * `packages/contracts/contracts/` and the SDK dispatch in `TokenService.ts` /
 * `paylink/*Submit.ts` / `ObsidionAccountEntrypoint.ts`.
 * The wallet's token artifact registers as `OxideToken` (not the Noir source
 * name `Token`).
 *
 * SCOPE: the functions reachable in the FIVE benchmarked Oxide flows (send,
 * withdraw, paylink create/claim/refund). First-party contracts that are NOT
 * benchmarked (e.g. `OidcKeyRegistry`) are intentionally absent — if one ever
 * appears in a benchmarked sim it redacts to `"<non-allowlisted>"` (safe, not a
 * leak) and the fixture test in simFunctionExtract.test.ts fails, forcing an
 * explicit, reviewed addition. Exported so that test can assert exact membership.
 */
export const ALLOWLISTED_NAMES: ReadonlySet<string> = new Set([
  // OxideToken (oxide_token_contract-OxideToken.json)
  "OxideToken:transfer",
  "OxideToken:withdraw",
  "OxideToken:publish_da",
  "OxideToken:claim",
  "OxideToken:recurse_subtract_balance_internal",
  // Account entrypoints (real + simulated stub + test)
  ...["ObsidionAccountAlpha", "ObsidionAccountAlphaSimulated", "ObsidionAccountAlphaTest"].flatMap(
    (c) => [
      `${c}:entrypoint`,
      `${c}:entrypoint_with_intent`,
    ],
  ),
  // Paylink contracts
  ...["PaylinkDirect", "PaylinkEmail"].flatMap((c) => [
    `${c}:claim`,
    `${c}:refund`,
    `${c}:deposit`,
  ]),
  // Fee-paying contracts
  "SponsorFPC:fee_entrypoint_private",
  "SponsorFPC:fee_entrypoint_public",
  "PasswordFPC:fee_entrypoint_private",
])

/** Protocol-circuit name prefixes (no first-party contract prefix) allowed verbatim. */
const ALLOWLISTED_PREFIXES = ["private_kernel_", "hiding_kernel"] as const

/**
 * Gate a raw upstream debug name. First-party contract functions match the
 * exact full-name set; protocol-kernel circuits match by prefix; everything else
 * is redacted to {@link NON_ALLOWLISTED}.
 */
export function normalizeFunctionName(functionName: string): string {
  if (ALLOWLISTED_NAMES.has(functionName)) return functionName
  if (ALLOWLISTED_PREFIXES.some((p) => functionName.startsWith(p))) return functionName
  return NON_ALLOWLISTED
}

/**
 * Sum every oracle's every recorded time. Reads numeric times only — no keys.
 * Defensively total: tolerates a malformed `oracles` map / non-array `times` /
 * non-numeric entries (returns what it can, never throws).
 */
function sumOracleTimes(oracles: Record<string, { times: number[] }> | undefined): number {
  if (!oracles || typeof oracles !== "object") return 0
  let total = 0
  for (const o of Object.values(oracles)) {
    const times = o?.times
    if (!Array.isArray(times)) continue
    for (const t of times) if (typeof t === "number") total += t
  }
  return total
}

/**
 * Extract the per-function sim breakdown from upstream `SimulationTimings`.
 *
 * Returns `undefined` when `timings` is absent (stats missing — kept
 * distinguishable from an empty result so a PXE regression surfaces rather than
 * silently dropping the breakdown). When present, returns an array (possibly
 * empty) of `SimFunctionTiming`, with names allowlist-gated and entries
 * aggregated by normalized name (so duplicate / redacted names collapse, summing
 * their witgen + oracle ms). Pure, total, never throws; never affects sample
 * status — this drill-down is purely additive. Defensively total: a malformed
 * `perFunction` (non-array) or row (missing name / non-numeric time / bad
 * oracles) is tolerated — bad rows skipped, good rows preserved. `undefined` is
 * reserved for absent `timings`; present-but-partly-malformed degrades to the
 * good rows (never `undefined`, so "no stats" stays distinguishable).
 */
export function extractSimFunctions(
  timings: SimulationTimings | undefined,
): SimFunctionTiming[] | undefined {
  if (!timings) return undefined

  const perFunction = Array.isArray(timings.perFunction) ? timings.perFunction : []
  const byName = new Map<string, SimFunctionTiming>()
  for (const fn of perFunction) {
    if (!fn || typeof fn.functionName !== "string") continue
    const witgenMs = typeof fn.time === "number" ? fn.time : 0
    const name = normalizeFunctionName(fn.functionName)
    const oracleMs = sumOracleTimes(fn.oracles)
    const existing = byName.get(name)
    if (existing) {
      existing.witgenMs += witgenMs
      existing.oracleMs += oracleMs
    } else {
      byName.set(name, { name, witgenMs, oracleMs })
    }
  }
  return Array.from(byName.values())
}
