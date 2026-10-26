/**
 * The resolver-operator records a registry holds over a deployment's life. Reading them scans the
 * deployment's whole operator log history, so signup, SIPA discovery and migration share one scan
 * for a few minutes. A failed scan is never kept.
 */

import type { Address, PublicClient } from "viem"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { fetchSipaResolverOperators, type SipaResolverOperatorRecord } from "@obsidion/sdk"
import { deploymentScanRange } from "./deploymentScanRange"

/** How long one scan answers for; a record written after it shows in the next. */
export const RESOLVER_RECORDS_REUSE_MS = 5 * 60_000

const scans = new Map<string, { at: number; records: Promise<SipaResolverOperatorRecord[]> }>()

/** Clears the cache - for testing only. */
export function resetResolverOperatorRecordsForTests(): void {
  scans.clear()
}

/**
 * Every operator `registry` recorded since `tuple`'s deployment started. `scanHead` bounds a scan
 * this call starts; a reused one answers with the head it was read at.
 */
export function readResolverOperatorRecords(
  publicClient: PublicClient,
  registry: Address,
  tuple: OxideEnvTuple,
  scanHead?: bigint,
): Promise<SipaResolverOperatorRecord[]> {
  const key = `${tuple.chainId ?? "?"}:${registry.toLowerCase()}:${
    tuple.deployedAtBlock ?? tuple.deployedAt
  }`
  const known = scans.get(key)
  if (known && Date.now() - known.at <= RESOLVER_RECORDS_REUSE_MS) return known.records
  const records = deploymentScanRange(publicClient, tuple, scanHead).then((range) =>
    // sdk's reads are typed against @aztec/viem; a plain-viem client is runtime-identical.
    fetchSipaResolverOperators(
      publicClient as unknown as Parameters<typeof fetchSipaResolverOperators>[0],
      registry,
      range,
    ),
  )
  scans.set(key, { at: Date.now(), records })
  records.catch(() => {
    if (scans.get(key)?.records === records) scans.delete(key)
  })
  return records
}
