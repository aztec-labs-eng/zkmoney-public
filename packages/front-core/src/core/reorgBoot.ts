/**
 * Boot wiring for the reorg layer, shared by every client: one ReorgMonitor over the wallet's
 * node, every txHash-bearing store, and the generation-freeze stand-down. Outcomes default to
 * the in-app reorg notification producer. The caller owns the lifecycle (start/stop on
 * foreground/visibility, the boot pass).
 */

import type { ObsidionWallet } from "@obsidion/sdk"
import { TxHash } from "@aztec/stdlib/tx"
import type { IStorageAdapter } from "./storages/adapter"
import { isFrozenGenerationVersion } from "./migration"
import {
  AppNotificationStore,
  ReorgMonitor,
  ReorgNotificationProducer,
  SIPADepositStore,
  WithdrawalStorage,
  WithdrawalTrackingService,
  runFreezeSweep,
  type ConfirmationListener,
} from "./services"
import type { ReorgNodeLike } from "./services/chain/receiptTypes"
import { TransactionStorage } from "./storages"

export interface CreateReorgMonitorOptions {
  wallet: Pick<ObsidionWallet, "node" | "pxe">
  storage: IStorageAdapter
  /** Defaults to the in-app reorg notification producer over `AppNotificationStore.get(storage)`. */
  onOutcome?: ConfirmationListener
}

export function createReorgMonitor({
  wallet,
  storage,
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

  const handleOutcome: ConfirmationListener =
    onOutcome ??
    ((outcome) =>
      ReorgNotificationProducer.getOrCreate({
        notificationStore: AppNotificationStore.get(storage),
      }).handleOutcome(outcome))

  // Freeze probe: the node reporting a rollupVersion the manifest lists as FROZEN means the
  // active generation froze. A version the manifest does not know (sandbox, staging previews,
  // fresh deploys) is not a freeze. One hit only arms a pending signal (a lone bad read must not
  // terminal-fail every watched payment); a second consecutive hit confirms — latched, no
  // unfreeze — and runs the once-per-launch freeze sweep so persisted rows get terminal demotes
  // + exit-required notices even on a cold launch into a frozen generation. A non-frozen probe
  // disarms; a probe error keeps the latched state.
  let frozen = false
  let pendingFreezeSignal = false
  let freezeSweepRan = false
  const isFrozen = async (): Promise<boolean> => {
    if (frozen) return true
    try {
      const info = await wallet.node.getNodeInfo()
      if (!isFrozenGenerationVersion(Number(info.rollupVersion))) {
        pendingFreezeSignal = false
        return false
      }
      if (!pendingFreezeSignal) {
        pendingFreezeSignal = true
        return true // unconfirmed: skip the pass, don't freeze yet
      }
      frozen = true
      monitor.setFrozen(true)
      if (!freezeSweepRan) {
        freezeSweepRan = true
        await runFreezeSweep({
          transactionStorage: TransactionStorage.get(storage),
          withdrawalStorage: WithdrawalStorage.get(storage),
          onOutcome: handleOutcome,
        }).catch((err: unknown) => {
          console.warn("[createReorgMonitor] freeze sweep failed:", err)
        })
      }
    } catch {
      // probe failed — keep the latched state
    }
    return frozen
  }

  const monitor = new ReorgMonitor({
    node: receiptNode,
    transactionStorage: TransactionStorage.get(storage),
    withdrawalStorage: WithdrawalStorage.get(storage),
    sipaDepositStore: SIPADepositStore.get(storage),
    // Withdrawal finalization re-check: re-arm the phase watcher; it re-reads the burn receipt and
    // $isWithdrawalSpent. Un-bootstrapped (sandbox / cold manifest) throws into the monitor's
    // guarded catch.
    rerunWithdrawalFinalization: () => WithdrawalTrackingService.get().resumeAll(),
    kickPxeSync: () => wallet.pxe.sync(),
    isFrozen,
    onOutcome: handleOutcome,
  })
  return monitor
}
