/**
 * Boot wiring for the reorg layer, shared by every client: one ReorgMonitor over the wallet's
 * node and every txHash-bearing store. Outcomes go to the caller's listener, which reports them in
 * the bell. The caller owns the lifecycle (start/stop on foreground/visibility, the boot pass).
 */

import type { ObsidionWallet } from "@obsidion/sdk"
import { TxHash } from "@aztec-labs/stdlib/tx"
import type { IStorageAdapter } from "./storages/adapter"
import {
  bootPriority,
  ReorgMonitor,
  SIPADepositStore,
  WithdrawalStorage,
  WithdrawalTrackingService,
  type ConfirmationListener,
} from "./services"
import type { ReorgNodeLike } from "./services/chain/receiptTypes"
import type { Activity } from "../engine/activity"

export interface CreateReorgMonitorOptions {
  wallet: Pick<ObsidionWallet, "node" | "pxe">
  storage: IStorageAdapter
  activity: Activity
  onOutcome: ConfirmationListener
}

export function createReorgMonitor({
  wallet,
  storage,
  activity,
  onOutcome,
}: CreateReorgMonitorOptions): ReorgMonitor {
  // Structural adapter: status/executionResult pass through as the @aztec enums; only branded
  // block fields become plain numbers/strings.
  const receiptNode: ReorgNodeLike = {
    getTxReceipt: async (txHash: string) => {
      const receipt = await wallet.node.getTxReceipt(TxHash.fromString(txHash))
      return {
        status: receipt.status,
        blockNumber: receipt.blockNumber !== undefined ? Number(receipt.blockNumber) : undefined,
        blockHash: receipt.blockHash?.toString(),
        executionResult: receipt.executionResult,
      }
    },
  }

  const monitor = new ReorgMonitor({
    node: receiptNode,
    transactionStorage: activity,
    withdrawalStorage: WithdrawalStorage.get(storage),
    sipaDepositStore: SIPADepositStore.get(storage),
    // Withdrawal finalization re-check: re-arm the phase watcher; it re-reads the burn receipt and
    // $isWithdrawalSpent. Un-bootstrapped (sandbox / cold manifest) throws into the monitor's
    // guarded catch.
    rerunWithdrawalFinalization: () => WithdrawalTrackingService.get().resumeAll(),
    // Until the first balance, the balance read's own sync brings note state up, and a sync here
    // would move the anchor that read checks.
    kickPxeSync: async () => {
      if (bootPriority.isReady("reorgSync")) await wallet.pxe.sync()
    },
    onOutcome,
  })
  return monitor
}
