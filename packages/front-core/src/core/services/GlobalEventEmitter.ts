import { EventEmitter } from "eventemitter3"

import type { TokenTransaction } from "../../types/transactions"

export interface GlobalEvents {
  accountUpdated: (detail?: { accountId: string }) => void
  incomingTransfer: (tx: TokenTransaction) => void
  transactionsUpdated: () => void
  /** Fired when a fresh device's first chain-sync pass begins (true) and when the last one ends (false). */
  syncCatchUpChanged: (catchingUp: boolean) => void
  /**
   * Fired once it is detected that a paylink has been claimed.
   */
  paylinkClaimed: (detail: { txHash: string }) => void
  /** Fired when a reorg demote flips a claimed paylink back to unclaimed. */
  paylinkClaimDemoted: (detail: { txHash: string }) => void
}

class GlobalEventEmitter extends EventEmitter<GlobalEvents> {
  private static instance: GlobalEventEmitter
  private syncCatchUps = 0

  constructor() {
    super()
  }

  public static getInstance(): GlobalEventEmitter {
    if (!GlobalEventEmitter.instance) {
      GlobalEventEmitter.instance = new GlobalEventEmitter()
    }
    return GlobalEventEmitter.instance
  }

  public emitAccountUpdated(detail?: { accountId: string }): void {
    this.emit("accountUpdated", detail)
  }

  public onAccountUpdated(listener: (detail?: { accountId: string }) => void): void {
    this.on("accountUpdated", listener)
  }

  public offAccountUpdated(listener: (detail?: { accountId: string }) => void): void {
    this.off("accountUpdated", listener)
  }

  public emitTransactionsUpdated(): void {
    this.emit("transactionsUpdated")
  }

  public onTransactionsUpdated(listener: () => void): void {
    this.on("transactionsUpdated", listener)
  }

  public offTransactionsUpdated(listener: () => void): void {
    this.off("transactionsUpdated", listener)
  }

  /** Holds the catch-up flag for one sync pass; the returned `end` is idempotent. */
  public beginSyncCatchUp(): () => void {
    if (++this.syncCatchUps === 1) this.emit("syncCatchUpChanged", true)
    let ended = false
    return () => {
      if (ended) return
      ended = true
      if (--this.syncCatchUps === 0) this.emit("syncCatchUpChanged", false)
    }
  }

  /** Current value for subscribers that mount mid-pass. */
  public isSyncCatchingUp(): boolean {
    return this.syncCatchUps > 0
  }

  public onSyncCatchUpChanged(listener: (catchingUp: boolean) => void): void {
    this.on("syncCatchUpChanged", listener)
  }

  public offSyncCatchUpChanged(listener: (catchingUp: boolean) => void): void {
    this.off("syncCatchUpChanged", listener)
  }

  public emitIncomingTransfer(tx: TokenTransaction): void {
    this.emit("incomingTransfer", tx)
  }

  public onIncomingTransfer(listener: (tx: TokenTransaction) => void): void {
    this.on("incomingTransfer", listener)
  }

  public offIncomingTransfer(listener: (tx: TokenTransaction) => void): void {
    this.off("incomingTransfer", listener)
  }

  public emitPaylinkClaimed(detail: { txHash: string }): void {
    this.emit("paylinkClaimed", detail)
  }

  public onPaylinkClaimed(listener: (detail: { txHash: string }) => void): void {
    this.on("paylinkClaimed", listener)
  }

  public offPaylinkClaimed(listener: (detail: { txHash: string }) => void): void {
    this.off("paylinkClaimed", listener)
  }

  public emitPaylinkClaimDemoted(detail: { txHash: string }): void {
    this.emit("paylinkClaimDemoted", detail)
  }

  public onPaylinkClaimDemoted(listener: (detail: { txHash: string }) => void): void {
    this.on("paylinkClaimDemoted", listener)
  }

  public offPaylinkClaimDemoted(listener: (detail: { txHash: string }) => void): void {
    this.off("paylinkClaimDemoted", listener)
  }

  public cleanup(): void {
    this.removeAllListeners()
  }
}

export const globalEventEmitter = GlobalEventEmitter.getInstance()
