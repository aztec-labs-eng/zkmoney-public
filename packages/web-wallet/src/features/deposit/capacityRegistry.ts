/** The page's one portal capacity registry (`capacityStore.ts` hands out its stores). */
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { createNode, Network, readPortalCapacity, type ObsidionWallet } from "@obsidion/sdk"
import {
  createPortalCapacityRegistry,
  nodeCapacityReference,
  type PortalCapacityRegistry,
  type QueryFactory,
  type Service,
  valueOf,
} from "@obsidion/front-core"
import type { WebWalletConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"

/** Before boot (request landing, registration terms), its node is one built like the app's. */
export function capacityRegistry(
  config: WebWalletConfig,
  wallet: Service<ObsidionWallet>,
  query: QueryFactory,
): PortalCapacityRegistry {
  let client: ReturnType<typeof l1PublicClient> | undefined
  let preBootNode: AztecNode | undefined
  return createPortalCapacityRegistry({
    // The key's chain id goes to the reader, so a key for another chain fails closed on this client.
    read: (key) => readPortalCapacity((client ??= l1PublicClient(config)), key),
    // The booted node's synced L1 time bounds a lagging capacity RPC even with a slow device clock.
    reference: nodeCapacityReference(
      () =>
        valueOf(wallet)?.node ?? (preBootNode ??= createNode(config.nodeUrl, config.nodeApiKey)),
    ),
    // The sandbox L1 mines on demand, so its head can be old or unchanged while still current.
    policy: config.network === Network.SANDBOX ? { maxHeadAgeMs: Infinity } : undefined,
    query,
  })
}
