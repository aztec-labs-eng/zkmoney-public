/**
 * The user's two exits from a withdrawal's escrow (a swap or a bridge-out) nobody is relaying, over
 * an injected L1 submission channel (any EOA can submit; the connected wallet pays gas):
 *
 *   - run it themselves: the factory's `deployAndExecute(args)`, which pays them the tip;
 *   - recover what it holds: the recovery account signs the escrow's `recoverERC20` through
 *     ERC-1271, failing closed unless the account and salt open the committed
 *     `recoveryCommitment`, and the token goes to `target` — deploying the clone first when it has
 *     no code, in the same transaction. The signature carries a short deadline: it is submitted at once, and past the
 *     deadline it can no longer divert DAI that reaches the escrow later.
 *
 * Both write the record on confirmation. Pure over injected collaborators so the sequence is
 * testable without a wallet or RPC.
 */

import { EthAddress } from "@aztec-labs/foundation/eth-address"
import type { Address, Hex } from "viem"
import { escrowERC20RecoveryDigest } from "@oxide/l1-contracts/escrow.js"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import type { SwapEscrowReader, SwapRecovery } from "@obsidion/sdk"
import { logger } from "../utils/logger"
import { WalletError } from "../engine/errors"

import {
  escrowHeldToken,
  escrowLeg,
  escrowRecoverCall,
  escrowRunCall,
} from "../core/services/bridge/escrowLeg"
import type { WithdrawalRecord } from "../core/services/bridge/types"
import type { Withdrawals } from "../engine/withdrawals"

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
  reader: Pick<SwapEscrowReader, "tokenBalance" | "isDeployed">
  store: Pick<Withdrawals, "apply">
}

export interface SwapEscrowRecoveryDeps extends SwapEscrowExitDeps {
  /** The account and salt the escrow's `recoveryCommitment` must open to. */
  recovery: SwapRecovery
  /** The recovery account's ERC-1271 signature over `digest`. */
  signAccount: (account: Address, digest: Hex) => Promise<Hex>
  /** Where the recovered token goes. */
  target: Address
  /** The withdrawn token (`tuple.token`). */
  dai: Address
  chainId: number
  /** Injectable for tests; defaults to crypto.getRandomValues. */
  makeNonce?: () => Uint8Array
  /** Latest L1 block timestamp in seconds: the escrow checks the deadline against `block.timestamp`. */
  chainNow: () => Promise<bigint>
}

/** The record's escrow leg, or a user-facing error when the record cannot rebuild it. */
function requireLeg(record: WithdrawalRecord) {
  const leg = escrowLeg(record)
  if (!leg) {
    throw new Error(
      "This withdrawal's escrow details weren't stored, so this wallet can't act on it.",
    )
  }
  return leg
}

/**
 * Guard against an escrow that has already been emptied of `token`: `deployAndExecute` would no-op
 * and `recoverERC20` would revert, either way costing the user a wallet prompt for nothing.
 */
export async function requireFunded(
  deps: Pick<SwapEscrowExitDeps, "reader">,
  escrow: Address,
  token: Address,
  ran = "This swap has already completed. The record will update shortly.",
): Promise<void> {
  if ((await deps.reader.tokenBalance(token, escrow)) === 0n)
    throw new WalletError("withdraw.escrowRan", ran)
}

function recordKey(record: WithdrawalRecord): string {
  return record.l2TxHash ?? record.localId
}

/**
 * Run the escrow as the relayer: `factory.deployAndExecute(args)`, tip to the submitter. A
 * bridge-out's run then waits on its bridge's fill.
 */
export async function runSwapEscrowExecute(
  deps: SwapEscrowExitDeps & { dai: Address },
): Promise<Hex> {
  const { record } = deps
  const leg = requireLeg(record)
  await requireFunded(deps, leg.escrow, deps.dai)
  const call = escrowRunCall(leg)

  logger.log(`[swapEscrow] executing ${leg.escrow.slice(0, 10)}… (awaiting wallet signature)`)
  const hash = await deps.channel.sendTransaction(call.to, call.data)
  logger.log(`[swapEscrow] execute tx ${hash} sent — awaiting receipt`)
  if (!(await deps.channel.waitForReceipt(hash))) {
    throw new Error(`swap transaction ${hash} reverted`)
  }
  await deps.store.apply(recordKey(record), {
    type: "patch",
    fields: {
      phase: leg.kind === "bridge" ? "bridging" : "done",
      swapExecuteTxHash: hash,
      reorgEpoch: record.reorgEpoch,
    },
  })
  logger.log(`[swapEscrow] executed ${leg.escrow.slice(0, 10)}… in tx ${hash}`)
  return hash
}

/** What an escrow recovery is signed with: everything in `SwapEscrowRecoveryDeps` but the record. */
export type EscrowRecoverySigning = Omit<SwapEscrowRecoveryDeps, "record" | "store">

/**
 * The recovery account's signature over the escrow's `recoverERC20` of its `token` to
 * `deps.target`, with the nonce and deadline it covers. Fails closed when the account and salt do
 * not open `recoveryCommitment` (a guaranteed revert) or the escrow holds none of `token`.
 */
export async function signEscrowRecovery(
  deps: Omit<EscrowRecoverySigning, "channel" | "dai">,
  escrow: Address,
  recoveryCommitment: Hex,
  token: Address,
  /** What the escrow is for, as the refusals name it, and what is said once it has run. */
  copy: { owner: string; ran?: string } = { owner: "withdrawal" },
): Promise<{ signature: Hex; nonce: Hex; deadline: bigint }> {
  const { recovery } = deps
  const commitment = deriveRecoveryCommitment(
    recovery.salt,
    EthAddress.fromString(recovery.account),
  )
  if (commitment.toString().toLowerCase() !== recoveryCommitment.toLowerCase()) {
    throw new Error(
      `This wallet's account is not the recovery account of this ${copy.owner}'s escrow`,
    )
  }
  await requireFunded(deps, escrow, token, copy.ran)
  const nonceBytes = deps.makeNonce?.() ?? crypto.getRandomValues(new Uint8Array(32))
  const nonce = `0x${Buffer.from(nonceBytes).toString("hex")}` as Hex
  const deadline = (await deps.chainNow()) + SWAP_ESCROW_RECOVERY_DEADLINE_S
  const digest = escrowERC20RecoveryDigest(
    escrow,
    BigInt(deps.chainId),
    deps.target,
    token,
    nonce,
    deadline,
  )
  return { signature: await deps.signAccount(recovery.account, digest), nonce, deadline }
}

/** Send what the escrow holds to `target`, signed by the recovery account. */
export async function runSwapEscrowRecovery(deps: SwapEscrowRecoveryDeps): Promise<Hex> {
  const { record, recovery } = deps
  const leg = requireLeg(record)
  const token = escrowHeldToken(leg, record, deps.dai)
  const signed = await signEscrowRecovery(deps, leg.escrow, leg.recoveryCommitment, token)
  const call = escrowRecoverCall(leg, {
    deployed: await deps.reader.isDeployed(leg.escrow),
    recovery,
    target: deps.target,
    token,
    ...signed,
  })

  logger.log(
    `[swapEscrow] recovering ${leg.escrow.slice(0, 10)}… → ${deps.target.slice(
      0,
      10,
    )}… (awaiting wallet signature)`,
  )
  const hash = await deps.channel.sendTransaction(call.to, call.data)
  logger.log(`[swapEscrow] recovery tx ${hash} sent — awaiting receipt`)
  if (!(await deps.channel.waitForReceipt(hash))) {
    throw new Error(`recovery transaction ${hash} reverted`)
  }
  await deps.store.apply(recordKey(record), {
    type: "patch",
    fields: {
      phase: "recovered",
      recoveryTxHash: hash,
      recoveryTarget: deps.target,
      reorgEpoch: record.reorgEpoch,
    },
  })
  logger.log(`[swapEscrow] recovered ${leg.escrow.slice(0, 10)}… in tx ${hash}`)
  return hash
}
