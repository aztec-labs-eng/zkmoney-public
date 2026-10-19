import type { EnsClient } from "@obsidion/front-core"
import { createPublicClient } from "viem"
import { getConfig, l1ChainFor, l1Transport } from "../config/env"

/** The active L1's ENS client, or null when that chain has no ENS registry (a local chain). */
export function ensClient(): EnsClient | null {
  const config = getConfig()
  const chain = l1ChainFor(config.l1ChainId)
  if (!chain.contracts?.ensUniversalResolver) return null
  return createPublicClient({ chain, transport: l1Transport(config) })
}
