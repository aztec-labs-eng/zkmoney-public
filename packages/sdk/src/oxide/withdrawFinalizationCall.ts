// The self-finalize exit for an L2->L1 withdrawal the relayer has not released: given only the
// burn tx hash, assemble the `OxidePortal.withdraw` call anyone may submit. The portal pays the
// plain withdrawal executor, which pays the burn's relayer tip to `tipRecipient` and the rest to
// the recipient the burn named.
//
// A relayer that wins the race makes this call revert (`OxidePortal__WithdrawalAlreadyClaimed`);
// the already-finalized read below is the cheap refusal before the enclave signs.
//
// This module stops at the calldata; who signs and broadcasts it is the caller's business.
//
// Narrow subpath imports only — the `@oxide/*` barrels re-export node-only modules that break
// browser bundles.
import { AztecAddress } from "@aztec/aztec.js/addresses"
import type { AztecNode } from "@aztec/aztec.js/node"
import { EthAddress } from "@aztec/foundation/eth-address"
import { TxHash } from "@aztec/stdlib/tx"

import { OxidePortalAbi } from "@oxide/l1-contracts/artifacts.js"
import { resolveBurnCheckpointArchive } from "@oxide/oxide-client/archive_ref.js"
import { buildWithdrawalPortalCalldata } from "@oxide/oxide-client/atlatl/process_withdrawal_request.js"
import { EnclaveUnavailable } from "@oxide/oxide-client/errors.js"
import { plainWithdrawalUserPayload } from "@oxide/oxide-client/published_withdrawal.js"
import { encodePlainRelayerPayload } from "@oxide/oxide-lib/plain_withdrawal.js"
import type { TeeSigner } from "@oxide/oxide-lib/types.js"

import { decodeFunctionData, type Address, type Hex, type PublicClient } from "viem"

import { fetchWithdrawalsWithIds, type WithdrawalPortalContext } from "./publishedWithdrawal.js"
import { isWithdrawalSpent } from "./withdrawalFinalization.js"

/**
 * The failures a caller can say something honest about. Everything else — an unreachable node, a
 * malformed burn, an enclave that answered and refused — propagates raw.
 */
export type WithdrawFinalizationFailure =
  /** `$isWithdrawalSpent` is already true: someone else released this withdrawal. */
  | "already-finalized"
  /** No outbox membership witness yet — the burn's epoch is not proven on L1. */
  | "not-yet-finalizable"
  /** The request never reached a working enclave. */
  | "enclave-unavailable"

export class WithdrawFinalizationError extends Error {
  constructor(
    readonly reason: WithdrawFinalizationFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = "WithdrawFinalizationError"
  }
}

export interface WithdrawFinalizationDeps {
  node: AztecNode
  /** Enclave RPC. Unauthenticated — it checks the request against chain data, not against a caller. */
  signer: TeeSigner
  portalContext: WithdrawalPortalContext
  /** The deployment's plain withdrawal executor; a burn through any other executor is refused. */
  plainWithdrawalExecutor: Hex
  /** L1 client for the already-finalized pre-flight. */
  l1: PublicClient
}

export interface WithdrawFinalizationArgs {
  /** L2 burn tx hash. Everything else re-derives from it. */
  burnTxHash: Hex
  /** Which published withdrawal of the burn. A wallet burn publishes one. */
  withdrawalIndex?: number
  /** Who the executor pays the burn's relayer tip to. */
  tipRecipient: Hex
  /** `WithdrawalSubsidy` to claim for `tipRecipient`; the zero address claims none. */
  withdrawalSubsidy?: Hex
}

export interface WithdrawFinalizationCall {
  /** The portal. */
  to: Address
  data: Hex
  withdrawalId: Hex
}

/**
 * Build the finalization call for `burnTxHash`.
 *
 * Ordered cheapest-first: the burn log and the already-finalized read cost two round trips, the
 * outbox witness one more, and only then does the enclave signature run — it replays the burn
 * checkpoint's blocks with bodies, which is a large fetch and must never be speculative.
 */
export async function buildWithdrawFinalizationCall(
  deps: WithdrawFinalizationDeps,
  args: WithdrawFinalizationArgs,
): Promise<WithdrawFinalizationCall> {
  const { node, portalContext } = deps
  const txHash = TxHash.fromString(args.burnTxHash)
  const index = args.withdrawalIndex ?? 0

  const { withdrawals } = await fetchWithdrawalsWithIds(node, txHash, portalContext)
  const withdrawal = withdrawals[index]
  if (!withdrawal) {
    throw new Error(
      `Burn tx ${args.burnTxHash} published ${withdrawals.length} withdrawals; no index ${index}.`,
    )
  }

  if (
    await isWithdrawalSpent(deps.l1, portalContext.l1Portal, withdrawal.withdrawalId.toString())
  ) {
    throw new WithdrawFinalizationError(
      "already-finalized",
      `Withdrawal ${withdrawal.withdrawalId} has already been released on L1.`,
    )
  }

  // Built server-side from the node's own Outbox; absent until a proven root covers the burn's
  // checkpoint, which is exactly the "not finalizable yet" signal.
  if (!(await node.getL2ToL1MembershipWitness(txHash, withdrawal.messageHash))) {
    throw new WithdrawFinalizationError(
      "not-yet-finalizable",
      `Burn tx ${args.burnTxHash} has no L2->L1 membership witness yet — its epoch is not proven.`,
    )
  }

  const userPayload = plainWithdrawalUserPayload(
    withdrawal,
    EthAddress.fromString(deps.plainWithdrawalExecutor),
    txHash,
  )
  const relayerPayload = encodePlainRelayerPayload({
    tipRecipient: EthAddress.fromString(args.tipRecipient),
    withdrawalSubsidy: args.withdrawalSubsidy
      ? EthAddress.fromString(args.withdrawalSubsidy)
      : EthAddress.ZERO,
  })

  let data: Hex
  try {
    data = await buildWithdrawalPortalCalldata(
      {
        chain: node,
        signer: deps.signer,
        l2Token: AztecAddress.fromStringUnsafe(portalContext.l2Portal),
        portal: {
          address: EthAddress.fromString(portalContext.l1Portal),
          getRollupVersion: () => Promise.resolve(portalContext.rollupVersion),
          getChainId: () => portalContext.l1ChainId,
        },
      },
      {
        txHash,
        archiveRoot: await resolveBurnCheckpointArchive(node, txHash),
        withdrawalIndex: index,
        userPayload,
        relayerPayload,
      },
    )
  } catch (err) {
    if (err instanceof EnclaveUnavailable) {
      throw new WithdrawFinalizationError(
        "enclave-unavailable",
        "The signing enclave could not be reached.",
        { cause: err },
      )
    }
    throw err
  }

  const withdrawalId = withdrawal.withdrawalId.toString() as Hex
  const signed = decodeFunctionData({ abi: OxidePortalAbi, data })
  if (
    signed.functionName !== "withdraw" ||
    signed.args[0].withdrawalId.toLowerCase() !== withdrawalId.toLowerCase()
  ) {
    throw new Error("Enclave finalization withdrawal ID does not match the published withdrawal.")
  }
  return { to: portalContext.l1Portal, data, withdrawalId }
}
