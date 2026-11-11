/**
 * The resolver-operator records a registry holds over a deployment's life, read from its
 * `ResolverOperatorUpdated` events. Signup, SIPA discovery and migration share one read for a few
 * minutes. The events read so far are saved with the block they reach, so a later read scans only
 * the blocks after it.
 */

import type { Address, PublicClient } from "viem"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  readSipaResolverOperatorEvents,
  sipaResolverOperatorsOf,
  type SipaResolverOperatorEvent,
  type SipaResolverOperatorRecord,
} from "@obsidion/sdk"
import type { Database } from "../engine/database"
import { persistentStore } from "../engine/persistentStore"
import type { QueryFactory } from "../engine/query"
import { keyedService } from "../engine/service"
import { deploymentStartBlock } from "./deploymentScanRange"

/** How long one read answers for; a record written after it shows in the next. */
export const RESOLVER_RECORDS_REUSE_MS = 5 * 60_000

/** Blocks read again below a saved scan's end, so an event a reorg dropped or moved is corrected. */
export const OPERATOR_SCAN_REORG_MARGIN = 128n

/** One registry's events over a deployment, from its start block to `through`. */
export interface OperatorScan {
  /** `<chain>:<registry>:<start block>`. */
  id: string
  events: SipaResolverOperatorEvent[]
  through: bigint
}

/** A page's operator-record reads over its L1 `client`, saved in `db`. */
export function deploymentScans(query: QueryFactory, client: () => PublicClient, db: Database) {
  const saved = keyedService("operatorScans", { retry: "manual" }, async () => {
    const store = persistentStore<OperatorScan>(db, {
      prefix: "scans/operatorRecords",
      version: 1,
      id: (scan) => scan.id,
      load: "all",
    })
    await store.ready
    return store
  })
  const records = query<[string | undefined, Address, bigint], SipaResolverOperatorRecord[]>(
    "operatorRecords",
    {
      load: async (chainId, registry, start, signal) => {
        const store = await saved().ready(signal)
        const id = `${chainId ?? "?"}:${registry.toLowerCase()}:${start}`
        const scan = await store.get(id)
        const publicClient = client()
        const head = await publicClient.getBlockNumber({ cacheTime: 0 })
        const resume = scan ? scan.through + 1n - OPERATOR_SCAN_REORG_MARGIN : start
        const from = resume > start ? resume : start
        if (scan && head < from) return sipaResolverOperatorsOf(scan.events)
        const fresh = await readSipaResolverOperatorEvents(publicClient, registry, {
          fromBlock: from,
          toBlock: head,
        })
        const events = [...(scan?.events.filter((e) => e.blockNumber < from) ?? []), ...fresh]
        await store.put({ id, events, through: head })
        return sipaResolverOperatorsOf(events)
      },
      stale: RESOLVER_RECORDS_REUSE_MS,
    },
  )
  return {
    /** Every operator `registry` recorded since `tuple`'s deployment started, up to the head. */
    operatorRecords: (registry: Address, tuple: OxideEnvTuple) =>
      records(tuple.chainId, registry, deploymentStartBlock(tuple)),
  }
}

export type DeploymentScans = ReturnType<typeof deploymentScans>
