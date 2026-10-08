/**
 * The boot cross-check between the node and L1: the node's `getNodeInfo()` must agree with the
 * identity read through the portal on chain id, rollup version, rollup address and Inbox address.
 * Pure; the platform boot performs both reads and decides what a mismatch means.
 */

import type { NodeInfo } from "@aztec/stdlib/contract"
import type { ChainIdentity } from "@obsidion/core/types"

export { L1IdentityUnavailableError, PortalIdentityMismatchError } from "@obsidion/sdk"

export type NodeIdentityField = keyof ChainIdentity

/** The node disagrees with L1 on `field`; `expected` is L1's value, `got` the node's. */
export class NodeIdentityMismatchError extends Error {
  readonly field: NodeIdentityField
  readonly expected: string | number
  readonly got: string | number

  constructor({
    field,
    expected,
    got,
  }: {
    field: NodeIdentityField
    expected: string | number
    got: string | number
  }) {
    super(`node reports ${field} ${got}, L1 says ${expected}`)
    this.name = "NodeIdentityMismatchError"
    this.field = field
    this.expected = expected
    this.got = got
    Object.setPrototypeOf(this, NodeIdentityMismatchError.prototype)
  }
}

export type NodeIdentityInfo = Pick<NodeInfo, "l1ChainId" | "rollupVersion"> & {
  l1ContractAddresses: Pick<NodeInfo["l1ContractAddresses"], "rollupAddress" | "inboxAddress">
}

/** Throws `NodeIdentityMismatchError` for the first field the node and L1 disagree on. */
export function verifyNodeIdentity({
  nodeInfo,
  expected,
}: {
  nodeInfo: NodeIdentityInfo
  expected: ChainIdentity
}): void {
  if (nodeInfo.l1ChainId !== expected.l1ChainId) {
    throw new NodeIdentityMismatchError({
      field: "l1ChainId",
      expected: expected.l1ChainId,
      got: nodeInfo.l1ChainId,
    })
  }
  const rollupVersion = String(nodeInfo.rollupVersion)
  if (rollupVersion !== expected.rollupVersion) {
    throw new NodeIdentityMismatchError({
      field: "rollupVersion",
      expected: expected.rollupVersion,
      got: rollupVersion,
    })
  }
  const rollupAddress = nodeInfo.l1ContractAddresses.rollupAddress.toString().toLowerCase()
  if (rollupAddress !== expected.rollupAddress.toLowerCase()) {
    throw new NodeIdentityMismatchError({
      field: "rollupAddress",
      expected: expected.rollupAddress,
      got: rollupAddress,
    })
  }
  const inboxAddress = nodeInfo.l1ContractAddresses.inboxAddress.toString().toLowerCase()
  if (inboxAddress !== expected.inboxAddress.toLowerCase()) {
    throw new NodeIdentityMismatchError({
      field: "inboxAddress",
      expected: expected.inboxAddress,
      got: inboxAddress,
    })
  }
}

/**
 * The profile's `shared.rollupVersion` against the pinned identity's. A difference is config drift,
 * not a node fault; the platform decides what it costs.
 */
export function profileRollupSkew(
  profileRollupVersion: string,
  identity: Pick<ChainIdentity, "rollupVersion">,
): { profile: string; l1: string } | undefined {
  if (profileRollupVersion === identity.rollupVersion) return undefined
  return { profile: profileRollupVersion, l1: identity.rollupVersion }
}
