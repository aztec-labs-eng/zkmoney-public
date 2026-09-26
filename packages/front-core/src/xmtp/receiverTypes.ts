/**
 * Shared ports for incoming-transfer ingest (`TransferEventScanner`) and its platform adapters.
 * Free of `@aztec/*` runtime imports: everything crosses these seams as primitives (hex strings,
 * stringified bigints, numbers).
 */

import type { TokenTransaction } from "../types/transactions"
import type { TokenInTxService } from "../types/tokens"

/**
 * Forward tag resolution: `senderTag → L2 address`, always a fresh registry read. Returns `null`
 * when the tag is not registered (permanent). Throws on transport / service failure — callers
 * defer and retry.
 */
export interface ITagForwardResolver {
  resolveL2(tag: string, rollupId: string): Promise<{ l2Address: string } | null>
}

/**
 * Contact-display lookup by L2 address. Implementations typically wrap `ContactStorage`. Returns
 * `null` when no contact is known for the sender; if `registerL2` is supplied, a verified
 * first-time sender is best-effort auto-added for display attribution.
 */
export type ContactsByL2 = {
  findByL2Address(addr: string): Promise<{ tag: string } | null>
  registerL2?(args: { tag: string; l2Address: string }): Promise<void>
}

/** TransactionStorage writes the ingest needs. */
export type TransactionStoreWrites = {
  /** Whether ANY stored row already carries this hash, whatever its action. */
  hasTxHash(txHash: string): Promise<boolean>
  addIncomingTokenTransaction(
    input: NewIncomingTokenTx,
  ): Promise<{ tx: TokenTransaction; inserted: boolean }>
}

/**
 * Payload for `addIncomingTokenTransaction`. Mirrors the
 * `TransactionStorage.addIncomingTokenTransaction` parameter shape.
 */
export type NewIncomingTokenTx = {
  /** Defaults to `receive`; a scanned `send` row never emits `incomingTransfer`. */
  action?: "send" | "receive"
  txHash: string
  from: string
  senderL2Address: string
  to: string
  token: TokenInTxService
  timestamp: number
  memo?: string
  /** Mined block of the emitting tx; the reorg watch anchor. */
  blockNumber?: number
  requestId?: string
  /** Network the event was scanned on; defaults to the active network at write time. */
  networkId?: string
  /** Raw amount in base units, from the decoded on-chain `Transfer` event. */
  amountAtomic?: string
}
