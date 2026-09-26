// The active network's identity (rollup L1 address string, same value as
// NetworkConfig.id / the pending-hint store's networkId). Published at wallet
// boot alongside setActiveGenerationNode; stores stamp it on chain-derived
// record writes so reconcile/demote paths can scope to the active network.
// Unset pre-boot — writers leave networkId undefined then.

let activeNetworkId: string | undefined

export function setActiveNetworkId(id: string | undefined): void {
  activeNetworkId = id
}

export function getActiveNetworkId(): string | undefined {
  return activeNetworkId
}
