/**
 * Rebuild the withdrawal records a store lost from the account's own `Withdraw` events. Every
 * burn the account made delivered one to it, its `meta` names the L1 address the burn pays, and a
 * swap's also carries the escrow args, so a fresh device gets its history back — and with it a
 * stuck or unswappable escrow's exits — from chain alone. A burn whose meta names no address is
 * skipped. Records the store already holds (by burn tx hash) are left as they are; the rest
 * are created at `l2_mined` for the tracker to walk forward like any mined burn. Pure over
 * injected collaborators.
 */

import { formatUnits, type Hash } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import type { ScannedWithdrawEvent, WithdrawEventSource } from "@obsidion/sdk"
import { globalEventEmitter } from "../GlobalEventEmitter"
import { newWithdrawalLocalId, type WithdrawalStorage } from "./WithdrawalStorage"
import type { WithdrawalDeployment, WithdrawalRecord } from "./types"

export interface WithdrawalRescanDeps {
  source: WithdrawEventSource
  store: Pick<WithdrawalStorage, "load" | "getByL2TxHash" | "create">
  tokenSymbol: string
  /** Stamped on every rebuilt record: the deployment whose token the events came from. */
  deployment?: WithdrawalDeployment
  /** First block to scan. Default 1, the lowest PXE accepts. */
  fromBlock?: number
  /** Stands in for a burn whose block time cannot be read. Defaults to Date.now. */
  now?: () => number
}

/** The records created, oldest burn first. */
export async function rebuildWithdrawals(deps: WithdrawalRescanDeps): Promise<WithdrawalRecord[]> {
  await deps.store.load()
  const head = await deps.source.headBlock()
  const events = await deps.source.listWithdrawals(deps.fromBlock ?? 1, head + 1)
  const missing = events
    .filter(
      (event): event is ScannedWithdrawEvent & { l1Recipient: Hash } =>
        event.l1Recipient !== undefined && !deps.store.getByL2TxHash(event.txHash),
    )
    .sort((a, b) => a.blockNumber - b.blockNumber)
  // Rebuilt rows join an in-progress chain catch-up so they land behind the activity skeleton.
  const end =
    missing.length && globalEventEmitter.isSyncCatchingUp()
      ? globalEventEmitter.beginSyncCatchUp()
      : undefined
  const created: WithdrawalRecord[] = []
  try {
    for (const event of missing) {
      const startTime =
        (await deps.source.blockTimestampMs(event.blockNumber)) ?? (deps.now ?? Date.now)()
      created.push(await deps.store.create(rebuiltRecord(event, startTime, deps)))
    }
  } finally {
    end?.()
  }
  return created
}

function rebuiltRecord(
  event: ScannedWithdrawEvent & { l1Recipient: Hash },
  startTime: number,
  deps: WithdrawalRescanDeps,
): WithdrawalRecord {
  const { swap } = event
  return {
    localId: newWithdrawalLocalId(),
    l2TxHash: event.txHash as Hash,
    blockNumber: event.blockNumber,
    recipient: swap?.recipient ?? event.l1Recipient,
    recipientProvenance: "saved-recipient",
    amount: formatUnits(event.amount, DEFAULT_DECIMALS),
    rawAmount: event.amount.toString(),
    tokenSymbol: deps.tokenSymbol,
    phase: "l2_mined",
    startTime,
    deployment: deps.deployment,
    rebuilt: true,
    ...(swap
      ? {
          swapOutput: swap.output,
          swapEscrow: event.l1Recipient,
          swapEscrowFactory: swap.factory,
          swapNonce: swap.nonce,
          swapRecoveryCommitment: swap.recoveryCommitment,
          swapRelayerTip: swap.relayerTip.toString(),
        }
      : {}),
  }
}
