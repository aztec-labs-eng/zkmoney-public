/**
 * The portal's `FPC_FUNDING_CUT`, cached per portal address.
 *
 * Every deposit quote, withdrawal quote and record writer prices against it, so it is read once per
 * deployment rather than per quote: it is a per-deployment immutable on the portal. An immutable read
 * that fails is retried before any screen reports it; only after the last attempt does the promise
 * reject and the cache slot drop, so the next caller reads again.
 */
import type { Address, PublicClient } from "viem"
import { readFpcFundingCut } from "@obsidion/sdk"
import { getConfig } from "../../config/env"
import { getOxideTuple, l1PublicClient, requireTupleField } from "../../config/oxideTuple"

/** Waits between the three attempts. */
const RETRY_DELAYS_MS = [500, 1_000]

let cache: { portal: string; value: Promise<bigint> } | undefined

async function readWithRetry(client: PublicClient, portal: Address): Promise<bigint> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readFpcFundingCut(client, portal)
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length) throw err
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]))
    }
  }
}

export function fpcFundingCut(client: PublicClient, portal: Address): Promise<bigint> {
  const key = portal.toLowerCase()
  if (cache?.portal !== key) {
    const value = readWithRetry(client, portal)
    cache = { portal: key, value }
    value.catch(() => {
      if (cache?.value === value) cache = undefined
    })
  }
  return cache.value
}

/** The cut for the active deployment, for callers holding neither a client nor the tuple. */
export async function currentFpcFundingCut(): Promise<bigint> {
  const config = getConfig()
  const tuple = await getOxideTuple(config)
  return fpcFundingCut(l1PublicClient(config), requireTupleField(tuple, "portal") as Address)
}
