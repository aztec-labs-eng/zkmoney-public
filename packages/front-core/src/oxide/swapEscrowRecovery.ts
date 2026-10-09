/**
 * The user's two exits from a swap-on-withdraw escrow nobody is relaying, over an injected L1
 * submission channel (any EOA can submit; the connected wallet pays gas):
 *
 *   - run the swap themselves: `SwapEscrowFactory.deployAndExecute(args)`, which pays them the tip;
 *   - recover the DAI: the recovery account signs the escrow's `recoverERC20` through ERC-1271,
 *     failing closed unless the account and salt open the committed `recoveryCommitment`, and the
 *     DAI goes to `target` — deploying the clone first when it has no code, in the same
 *     transaction. The signature carries a short deadline: it is submitted at once, and past the
 *     deadline it can no longer divert DAI that reaches the escrow later.
 *
 * Both write the record on confirmation. Pure over injected collaborators so the sequence is
 * testable without a wallet or RPC.
 */

import { EthAddress } from "@aztec/foundation/eth-address"
import type { Address, Hex } from "viem"
import { escrowERC20RecoveryDigest } from "@oxide/l1-contracts/escrow.js"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import {
  buildSwapEscrowExecuteCall,
  buildSwapEscrowRecoverCall,
  type SwapEscrowReader,
  type SwapRecovery,
} from "@obsidion/sdk"
import { logger } from "src/utils/logger"

import { swapEscrowTarget } from "../core/services/bridge/swapEscrowArgs"
import type { WithdrawalRecord } from "../core/services/bridge/types"
import type { WithdrawalStorage } from "../core/services/bridge/WithdrawalStorage"

/** How long a recovery signature stays valid after signing, in chain seconds. */
export const SWAP_ESCROW_RECOVERY_DEADLINE_S = 60n * 60n

/** Who the transaction pays and how it reaches L1. */
export interface SwapEscrowExitChannel {
  sendTransaction: (to: Address, data: Hex) => Promise<Hex>
  /** False on a reverted transaction. */
  waitForReceipt: (hash: Hex) => Promise<boolean>
}

export interface SwapEscrowExitDeps {
  record: WithdrawalRecord
  channel: SwapEscrowExitChannel
  reader: Pick<SwapEscrowReader, "daiBalance" | "isDeployed">
  store: Pick<WithdrawalStorage, "patch">
}

export interface SwapEscrowRecoveryDeps extends SwapEscrowExitDeps {
  /** The account and salt the escrow's `recoveryCommitment` must open to. */
  recovery: SwapRecovery
  /** The recovery account's ERC-1271 signature over `digest`. */
  signAccount: (account: Address, digest: Hex) => Promise<Hex>
  /** Where the DAI goes. */
  target: Address
  /** The withdrawn token (`tuple.token`). */
  dai: Address
  chainId: number
  /** Injectable for tests; defaults to crypto.getRandomValues. */
  makeNonce?: () => Uint8Array
  /** Latest L1 block timestamp in seconds: the escrow checks the deadline against `block.timestamp`. */
  chainNow: () => Promise<bigint>
}

/** The record's escrow, or a user-facing error when the record cannot rebuild it. */
function requireTarget(record: WithdrawalRecord) {
  const target = swapEscrowTarget(record)
  if (!target) {
    throw new Error(
      "This withdrawal's escrow details weren't stored, so this wallet can't act on it.",
    )
  }
  return target
}

/**
 * Guard against an escrow that has already been emptied: `deployAndExecute` would no-op and `recoverERC20`
 * would revert, either way costing the user a wallet prompt for nothing.
 */
async function requireFunded(deps: SwapEscrowExitDeps, escrow: Address): Promise<void> {
  if ((await deps.reader.daiBalance(escrow)) === 0n) {
    throw new Error("This swap has already completed. The record will update shortly.")
  }
}

function recordKey(record: WithdrawalRecord): string {
  return record.l2TxHash ?? record.localId
}

/** Run the escrow's swap as the relayer: `factory.deployAndExecute(args)`, tip to the submitter. */
export async function runSwapEscrowExecute(deps: SwapEscrowExitDeps): Promise<Hex> {
  const { record } = deps
  const target = requireTarget(record)
  await requireFunded(deps, target.escrow)
  const call = buildSwapEscrowExecuteCall(target.factory, target)

  logger.log(`[swapEscrow] executing ${target.escrow.slice(0, 10)}… (awaiting wallet signature)`)
  const hash = await deps.channel.sendTransaction(call.to, call.data)
  logger.log(`[swapEscrow] execute tx ${hash} sent — awaiting receipt`)
  if (!(await deps.channel.waitForReceipt(hash))) {
    throw new Error(`swap transaction ${hash} reverted`)
  }
  await deps.store.patch(recordKey(record), {
    phase: "done",
    swapExecuteTxHash: hash,
    reorgEpoch: record.reorgEpoch,
  })
  logger.log(`[swapEscrow] executed ${target.escrow.slice(0, 10)}… in tx ${hash}`)
  return hash
}

/** Send the escrow's DAI to `target`, signed by the recovery account. */
export async function runSwapEscrowRecovery(deps: SwapEscrowRecoveryDeps): Promise<Hex> {
  const { record, recovery } = deps
  const target = requireTarget(record)

  // Fail closed: an account or salt that does not open the commitment is a guaranteed
  // recovery-commitment-mismatch revert.
  const commitment = deriveRecoveryCommitment(
    recovery.salt,
    EthAddress.fromString(recovery.account),
  )
  if (commitment.toString().toLowerCase() !== target.args.recoveryCommitment.toLowerCase()) {
    throw new Error("This wallet's account is not the recovery account of this withdrawal's escrow")
  }
  await requireFunded(deps, target.escrow)

  const nonceBytes = deps.makeNonce?.() ?? crypto.getRandomValues(new Uint8Array(32))
  const nonce = `0x${Buffer.from(nonceBytes).toString("hex")}` as Hex
  const deadline = (await deps.chainNow()) + SWAP_ESCROW_RECOVERY_DEADLINE_S
  const digest = escrowERC20RecoveryDigest(
    target.escrow,
    BigInt(deps.chainId),
    deps.target,
    deps.dai,
    nonce,
    deadline,
  )
  const call = buildSwapEscrowRecoverCall({
    deployed: await deps.reader.isDeployed(target.escrow),
    factory: target.factory,
    escrow: target.escrow,
    commitment: target,
    recovery,
    signature: await deps.signAccount(recovery.account, digest),
    target: deps.target,
    token: deps.dai,
    nonce,
    deadline,
  })

  logger.log(
    `[swapEscrow] recovering ${target.escrow.slice(0, 10)}… → ${deps.target.slice(
      0,
      10,
    )}… (awaiting wallet signature)`,
  )
  const hash = await deps.channel.sendTransaction(call.to, call.data)
  logger.log(`[swapEscrow] recovery tx ${hash} sent — awaiting receipt`)
  if (!(await deps.channel.waitForReceipt(hash))) {
    throw new Error(`recovery transaction ${hash} reverted`)
  }
  await deps.store.patch(recordKey(record), {
    phase: "recovered",
    recoveryTxHash: hash,
    recoveryTarget: deps.target,
    reorgEpoch: record.reorgEpoch,
  })
  logger.log(`[swapEscrow] recovered ${target.escrow.slice(0, 10)}… in tx ${hash}`)
  return hash
}
