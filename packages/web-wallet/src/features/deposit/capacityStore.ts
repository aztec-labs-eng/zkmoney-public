/**
 * The web wallet's one portal capacity registry. Every screen that shows or checks deposit capacity (connected
 * funding, addresses, pending deposits) takes its store from here, so each bucket has one poll and one observation.
 * The UI capture server replaces this module to drive capacity states without a chain.
 */
import type { AztecNode } from "@aztec/aztec.js/node"
import { createNode, Network, readPortalCapacity } from "@obsidion/sdk"
import {
  browserVisibility,
  createPortalCapacityRegistry,
  getActiveGenerationNode,
  nodeCapacityReference,
  portalCapacityKey,
  type PortalCapacityKey,
  type PortalCapacityRegistry,
  type PortalCapacityStore,
} from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { getOxideTuple, l1PublicClient } from "../../config/oxideTuple"

let registry: PortalCapacityRegistry | undefined
/** Before boot (request landing, registration terms): a client built like the app's, with its API key. */
let preBootNode: AztecNode | undefined

function capacityRegistry(): PortalCapacityRegistry {
  if (!registry) {
    const config = getConfig()
    const client = l1PublicClient(config)
    registry = createPortalCapacityRegistry({
      // The key's chain id goes to the reader, so a key for another chain fails closed on this client.
      read: (key) => readPortalCapacity(client, key),
      // The booted node's synced L1 time bounds a lagging capacity RPC even with a slow device clock.
      reference: nodeCapacityReference(
        () =>
          getActiveGenerationNode() ??
          (preBootNode ??= createNode(config.nodeUrl, config.nodeApiKey)),
      ),
      // The sandbox L1 mines on demand, so its head can be old or unchanged while still current.
      policy: config.network === Network.SANDBOX ? { maxHeadAgeMs: Infinity } : undefined,
      visibility: browserVisibility(),
    })
  }
  return registry
}

/**
 * The shared store for one capacity bucket. Pass the portal a deposit was made to (it may differ from the active
 * deployment), or `await activeCapacityKey()` for new funding. Throws on a malformed key.
 */
export function depositCapacityStore(key: PortalCapacityKey): PortalCapacityStore {
  return capacityRegistry().store(key)
}

/** The bucket new deposits fund: the active deployment's portal and settlement token. */
export async function activeCapacityKey(): Promise<PortalCapacityKey> {
  return portalCapacityKey(await getOxideTuple(getConfig()))
}
