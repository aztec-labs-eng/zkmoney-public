/**
 * The page's portal capacity stores. Every screen that shows or checks deposit capacity (connected
 * funding, addresses, pending deposits) takes its store from here, so each bucket has one poll and one observation.
 * The UI capture server replaces this module to drive capacity states without a chain.
 */
import {
  portalCapacityKey,
  type PortalCapacityKey,
  type PortalCapacityStore,
} from "@obsidion/front-core"
import { bridgeByToken, bridgeUnderlying } from "@obsidion/core/oxide"
import type { PageFacts } from "../../session/pageChain"
import type { Session } from "../../session/session"

/**
 * The shared store for one capacity bucket. Pass the portal a deposit was made to (it may differ from the active
 * deployment), or `await activeCapacityKey()` for new funding. Throws on a malformed key.
 */
export function depositCapacityStore(
  { capacity }: Pick<Session["page"], "capacity">,
  key: PortalCapacityKey,
): PortalCapacityStore {
  return capacity.store(key)
}

/**
 * The bucket new deposits fund: the portal of `rowToken`'s row, or the pinned bridge's when no row is named. A row
 * the pinned deployment has no bridge for throws.
 */
export async function activeCapacityKey(
  { chain }: PageFacts,
  rowToken?: string,
): Promise<PortalCapacityKey> {
  if (!rowToken) {
    const tuple = await chain.oxideTuple.read()
    return portalCapacityKey({ ...tuple, token: bridgeUnderlying(tuple) })
  }
  const bridge = bridgeByToken((await chain.oxideDeployment.read()).deployment, rowToken)
  if (!bridge) throw new Error(`The pinned deployment has no bridge for ${rowToken}`)
  return portalCapacityKey({ ...bridge.tuple, token: bridge.underlying })
}
