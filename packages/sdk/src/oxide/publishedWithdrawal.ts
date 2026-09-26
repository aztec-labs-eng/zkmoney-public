// Read-side primitives for oxide L2->L1 withdrawals. The burn path
// (`TokenService.exitToL1Private`) emits a public per-withdrawal log on L2; this
// module reads that log back and derives the `withdrawalId` an L1 finalizer (and
// the client's finalization watcher) key on.
//
// Narrow subpath imports only — the `@oxide/oxide-client` and `@oxide/oxide-lib`
// barrels re-export node/backend-only modules that break browser bundles.
import { Buffer32 } from "@aztec/foundation/buffer"
import { sha256 } from "@aztec/foundation/crypto/sha256"
import type { Fr } from "@aztec/foundation/curves/bn254"
import { EthAddress } from "@aztec/foundation/eth-address"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import type { BlockHash } from "@aztec/stdlib/block"
import type { AztecNode } from "@aztec/stdlib/interfaces/client"
import type { TxHash } from "@aztec/stdlib/tx"

import { computeWithdrawMessageHash } from "@oxide/oxide-lib/hash.js"
import type { OutboxWithdrawal, PortalContext } from "@oxide/oxide-lib/types.js"
import {
  type PublishedWithdrawal,
  fetchPublishedWithdrawals,
} from "@oxide/oxide-client/published_withdrawal.js"

import type { Hex } from "viem"

export { fetchPublishedWithdrawals }
export type { PublishedWithdrawal }

/**
 * Portal identity, in the serialization-friendly (string/bigint) shape the app
 * carries it in, mapped explicitly from an `OxideEnvTuple`:
 *   l1Portal     = tuple.portal          (L1 TEE portal, 20-byte hex)
 *   l2Portal     = tuple.l2Token         (L2 oxide-token address; the message hash
 *                                         binds the L2 sender to this)
 *   rollupVersion = BigInt(tuple.rollupVersion)
 *   l1ChainId    = target-chain id       (Sepolia 11155111 / the node's l1ChainId)
 * The env tuple carries no `l2Portal`/`l1ChainId` of its own, so this mapping is
 * the load-bearing invariant: a wrong `l2Portal` (or chain id) yields a wrong
 * `withdrawalId` and `$isWithdrawalSpent` never flips true.
 */
export interface WithdrawalPortalContext {
  l1Portal: Hex
  l2Portal: string
  rollupVersion: bigint
  l1ChainId: bigint
}

function toOxidePortalContext(ctx: WithdrawalPortalContext): PortalContext {
  return {
    l1Portal: EthAddress.fromString(ctx.l1Portal),
    l2Portal: AztecAddress.fromStringUnsafe(ctx.l2Portal),
    rollupVersion: ctx.rollupVersion,
    l1ChainId: ctx.l1ChainId,
  }
}

/**
 * `withdrawalId = sha256(burnTxHash ‖ withdrawMessageHash)` — byte concat of the
 * two 32-byte buffers, matching the enclave (`tee-enclave/src/signer.ts`). The
 * message hash binds the portal context (`l2Portal`/`l1Portal`/`rollupVersion`/
 * `l1ChainId`) to the withdrawal fields. Pure: no node access, so it is the
 * byte-vector-testable core of the derivation.
 */
export function computeWithdrawalId(
  ctx: WithdrawalPortalContext,
  txHash: TxHash,
  withdrawal: OutboxWithdrawal,
): { messageHash: Fr; withdrawalId: Buffer32 } {
  const messageHash = computeWithdrawMessageHash(toOxidePortalContext(ctx), withdrawal)
  const withdrawalId = new Buffer32(
    sha256(Buffer.concat([txHash.toBuffer(), messageHash.toBuffer()])),
  )
  return { messageHash, withdrawalId }
}

/** A published withdrawal plus its derived finalization keys. */
export interface DerivedWithdrawal extends PublishedWithdrawal {
  messageHash: Fr
  withdrawalId: Buffer32
}

/**
 * Read the withdrawal(s) published in a burn tx and derive each `withdrawalId`.
 * A wallet burn publishes a single withdrawal, so callers use `withdrawals[0]`;
 * the array mirrors the underlying reader (a tx may carry several).
 *
 * Surfaces `fetchPublishedWithdrawals`' throw when the burn's tx effect is not
 * yet indexed (`node.getTxEffect` undefined) — the watcher treats that as
 * retryable (re-derive next tick), NOT a terminal failure.
 */
export async function fetchWithdrawalsWithIds(
  node: AztecNode,
  txHash: TxHash,
  ctx: WithdrawalPortalContext,
): Promise<{ withdrawals: DerivedWithdrawal[]; anchorBlockHash: BlockHash }> {
  const oxideCtx = toOxidePortalContext(ctx)
  const { withdrawals, anchorBlockHash } = await fetchPublishedWithdrawals(
    node,
    txHash,
    oxideCtx.l2Portal,
  )
  const derived = withdrawals.map((withdrawal) => {
    const messageHash = computeWithdrawMessageHash(oxideCtx, withdrawal)
    const withdrawalId = new Buffer32(
      sha256(Buffer.concat([txHash.toBuffer(), messageHash.toBuffer()])),
    )
    return { ...withdrawal, messageHash, withdrawalId }
  })
  return { withdrawals: derived, anchorBlockHash }
}
