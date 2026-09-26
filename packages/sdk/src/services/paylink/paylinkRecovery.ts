import { ContractArtifact } from "@aztec/aztec.js/abi"
import { Fr } from "@aztec/aztec.js/fields"
import type { AztecNode } from "@aztec/aztec.js/node"
import type { BlockNumber } from "@aztec/foundation/branded-types"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import {
  getContractInstanceFromInstantiationParams,
  type ContractInstanceWithAddress,
} from "@aztec/stdlib/contract"
import { computeSiloedPrivateInitializationNullifier } from "@aztec/stdlib/hash"
import { MerkleTreeId } from "@aztec/stdlib/trees"
import { TxHash } from "@aztec/stdlib/tx"
import type { ContractName } from "@obsidion/contracts"
import {
  deriveDeterministicPaylinkKeys,
  MAX_PAYLINK_NONCES_PER_DAY,
  type PaylinkDerivedKeyMaterial,
} from "./paylinkKeys.js"

// 2026-08-06 — the day nonce-derived paylink escrows shipped. No derived escrow can predate it, so
// recovery scans start here when the caller has nothing better (e.g. the account creation day).
export const PAYLINK_NONCE_EPOCH_DAY = 20671

/** The two node reads recovery needs — a Pick so tests can stub them without a PXE. */
export type PaylinkScanNode = Pick<AztecNode, "findLeavesIndexes" | "getBlock">

export interface RecoveredPaylinkEscrow {
  day: number
  n: number
  keys: PaylinkDerivedKeyMaterial
  instance: ContractInstanceWithAddress
  address: AztecAddress
  initHash: Fr
  l2BlockNumber: BlockNumber
}

/**
 * Enumerate every escrow a creator ever made from the master secret alone: derive the
 * `(day, n, flavor)` key grid, compute each candidate's counterfactual address (zero `initHash`,
 * keys as the only variable input) and probe its private initialization nullifier — public tree
 * data, no notes, no logs, no local state.
 */
// ponytail: cost is linear in days scanned (~64 derivations + 1 batched RPC per day, empty or not);
// narrow the window with a per-account start day before this matters.
export async function scanPaylinkEscrows(args: {
  node: PaylinkScanNode
  artifact: ContractArtifact
  flavor: ContractName
  masterSecret: Fr
  fromDay: number
  toDay: number
  noncesPerDay?: number
}): Promise<RecoveredPaylinkEscrow[]> {
  const { node, artifact, flavor, masterSecret, fromDay, toDay } = args
  const noncesPerDay = args.noncesPerDay ?? MAX_PAYLINK_NONCES_PER_DAY
  const hits: RecoveredPaylinkEscrow[] = []

  for (let day = fromDay; day <= toDay; day++) {
    const candidates = await Promise.all(
      Array.from({ length: noncesPerDay }, async (_, n) => {
        const keys = await deriveDeterministicPaylinkKeys(masterSecret, day, n, flavor)
        const instance = await getContractInstanceFromInstantiationParams(artifact, {
          salt: new Fr(0n),
          publicKeys: keys.publicKeys,
        })
        return { n, keys, instance }
      }),
    )

    const nullifiers = await Promise.all(
      candidates.map(({ instance }) =>
        computeSiloedPrivateInitializationNullifier(instance.address, instance.initializationHash),
      ),
    )
    const leaves = await node.findLeavesIndexes("latest", MerkleTreeId.NULLIFIER_TREE, nullifiers)

    for (const [i, leaf] of leaves.entries()) {
      if (leaf?.data === undefined) continue
      const { n, keys, instance } = candidates[i]!
      hits.push({
        day,
        n,
        keys,
        instance,
        address: instance.address,
        initHash: instance.initializationHash,
        l2BlockNumber: leaf.l2BlockNumber,
      })
    }
  }

  return hits
}

/**
 * The deposit tx of a recovered escrow, located from public data: the init nullifier's block is
 * known from the probe, and exactly one tx effect in it carries that nullifier. The tx hash is what
 * the refund pipeline needs to sync the escrow note.
 */
export async function findDepositTxHash(
  node: PaylinkScanNode,
  escrow: Pick<RecoveredPaylinkEscrow, "address" | "initHash" | "l2BlockNumber">,
): Promise<TxHash> {
  const block = await node.getBlock(escrow.l2BlockNumber, { includeTransactions: true })
  if (!block?.body) throw new Error(`recovery: block ${escrow.l2BlockNumber} not found`)
  const initNullifier = await computeSiloedPrivateInitializationNullifier(
    escrow.address,
    escrow.initHash,
  )
  for (const txEffect of block.body.txEffects) {
    if (txEffect.nullifiers.some((nf) => nf.equals(initNullifier))) return txEffect.txHash
  }
  throw new Error(`recovery: no tx in block ${escrow.l2BlockNumber} carries the init nullifier`)
}

/**
 * The tx that funded an escrow, from its init nullifier alone — public tree data, so a link holder
 * finds it with nothing but the secret. Undefined while the escrow is not yet initialized.
 */
export async function findEscrowDepositTx(
  node: PaylinkScanNode,
  instance: Pick<ContractInstanceWithAddress, "address" | "initializationHash">,
): Promise<{ txHash: TxHash; l2BlockNumber: BlockNumber } | undefined> {
  const initNullifier = await computeSiloedPrivateInitializationNullifier(
    instance.address,
    instance.initializationHash,
  )
  const [leaf] = await node.findLeavesIndexes("latest", MerkleTreeId.NULLIFIER_TREE, [initNullifier])
  if (leaf?.data === undefined) return undefined
  const escrow = { address: instance.address, initHash: instance.initializationHash, l2BlockNumber: leaf.l2BlockNumber }
  return { txHash: await findDepositTxHash(node, escrow), l2BlockNumber: leaf.l2BlockNumber }
}
