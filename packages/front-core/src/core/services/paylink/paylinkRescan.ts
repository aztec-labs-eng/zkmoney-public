/**
 * Rebuild the creator PAY rows a store lost from the account's own `Transfer` copies. The token
 * delivers each funding transfer to its sender too, and the escrow announces the link in that
 * transfer's meta, so a fresh device gets its active links back from chain plus the master secret,
 * which re-derives the creator-only refund material. Existing PAY rows are preserved; plain sends
 * from the transfer scanner are upgraded by funding tx hash. A spent
 * escrow (claimed or refunded) is skipped, and a link whose note cannot be read yet is retried on
 * the next pass. Each pass resumes from a persisted block cursor, a reorg margin behind (the
 * store's tx-hash dedup absorbs the overlap), and the cursor never passes a deferred link or PXE's
 * synced block. Pure over injected collaborators.
 */

import type { Fr } from "@aztec/aztec.js/fields"
import { TokenActionEnum } from "@obsidion/core/constants"
import type { PaylinkService, RecoveredPaylinkParams, TransferEventSource } from "@obsidion/sdk"
import type { PaylinkTransaction } from "src/types"
import type { IStorageAdapter } from "../../storages/adapter"
import type { TransactionStorage } from "../../storages/TransactionStorage"
import {
  buildTokenInTxService,
  TRANSFER_SCAN_REORG_MARGIN,
} from "../transactions/TransferEventScanner"
import { logger } from "src/utils/logger"

const CURSOR_STORAGE_KEY = "@obsidion/paylink-rescan/cursor/v1"

export interface PaylinkRescanDeps {
  source: Pick<TransferEventSource, "headBlock" | "listIncoming" | "blockTimestampMs" | "anchorBlock">
  /** Holds the block cursor per network and account. Absent, every pass scans from `fromBlock`. */
  storage?: Pick<IStorageAdapter, "getItem" | "setItem">
  accountAddress: string
  /** The creator's master secret: re-derives each announced escrow's creator-only key material. */
  masterSecret: Fr
  /** Rollup identity of the source wallet, captured before scanning. */
  networkId: string
  /** Abort when the owning account/network mount is disposed. */
  signal?: AbortSignal
  paylinkService: Pick<PaylinkService, "recoverPaylinkFromTransfer" | "isPaylinkClaimed" | "sync_note">
  /** The share URL the platform writes on a created row, so a rebuilt row opens the same way. */
  linkFor: (params: RecoveredPaylinkParams) => string | Promise<string>
  store: Pick<TransactionStorage, "hasTxHash" | "findByTxHash" | "addRecoveredPaylinkTransaction">
  token: { address: string; symbol: string; decimals: number }
  /** First block to scan when no cursor is stored. Default 1, the lowest PXE accepts. */
  fromBlock?: number
  /** Stands in for a funding tx whose block time cannot be read. Defaults to Date.now. */
  now?: () => number
}

/** The rows created, oldest funding tx first. */
export async function rebuildPaylinks(deps: PaylinkRescanDeps): Promise<PaylinkTransaction[]> {
  const created: PaylinkTransaction[] = []
  if (deps.signal?.aborted) return created
  const me = deps.accountAddress.toLowerCase()
  const head = await deps.source.headBlock()
  if (deps.signal?.aborted) return created
  // PXE's synced block: events past it are not decryptable yet, so the cursor never passes it.
  const anchor = Math.min(head, (await deps.source.anchorBlock?.()) ?? head)
  const cursorKey = `${CURSOR_STORAGE_KEY}/${deps.networkId}/${me}`
  const start = deps.fromBlock ?? 1
  const cursor = deps.storage ? await loadCursor(deps.storage, cursorKey) : undefined
  // A cursor past the anchor means PXE was rebuilt or head regressed: resume from the anchor.
  const from = Math.max(start, Math.min(cursor ?? start, anchor) - TRANSFER_SCAN_REORG_MARGIN)
  if (deps.signal?.aborted) return created
  const events = await deps.source.listIncoming(from, head + 1)
  // The oldest link whose note could not be read yet; the cursor stops short of it.
  let heldAt: number | undefined
  for (const event of [...events].sort((a, b) => a.blockNumber - b.blockNumber)) {
    if (deps.signal?.aborted) break
    if (!event.paylinkCreated || event.from.toLowerCase() !== me) continue
    if (
      (await deps.store.hasTxHash(event.txHash)) &&
      (await deps.store.findByTxHash(event.txHash))?.action !== TokenActionEnum.SEND
    )
      continue
    if (deps.signal?.aborted) break
    const params = await deps.paylinkService.recoverPaylinkFromTransfer(event, deps.masterSecret)
    if (deps.signal?.aborted) break
    if (!params) continue
    const spent = await deps.paylinkService.isPaylinkClaimed(params)
    if (deps.signal?.aborted) break
    if (spent) continue
    let note
    try {
      note = await deps.paylinkService.sync_note(params)
    } catch (err) {
      logger.warn(`[paylinkRescan] note read deferred for ${event.txHash}:`, err)
      heldAt ??= event.blockNumber
      continue
    }
    if (deps.signal?.aborted) break
    const timestamp =
      (await deps.source.blockTimestampMs?.(event.blockNumber)) ?? (deps.now ?? Date.now)()
    if (deps.signal?.aborted) break
    const paylink = await deps.linkFor(params)
    if (deps.signal?.aborted) break
    const { tx, inserted } = await deps.store.addRecoveredPaylinkTransaction({
      networkId: deps.networkId,
      txHash: event.txHash,
      flavor: event.paylinkCreated.flavor,
      // Single USD-pegged asset; the activity feed multiplies amount × price, as the create rows do.
      token: { ...buildTokenInTxService({ ...deps.token, rawAmount: event.amount }), price: 1 },
      timestamp,
      blockNumber: event.blockNumber,
      to: params.email,
      payToEmailSecret: params.secret.toString(),
      obsidionAccountAddress: deps.accountAddress,
      tokenAddress: deps.token.address,
      paylink,
      fallbackSecret: params.fallbackSecret.toString(),
      fromClaimable: note.claimableFrom,
      untilClaimable: note.claimableUntil,
      refundableUntil: note.refundableUntil,
      memo: event.memo,
    })
    if (inserted) created.push(tx)
  }
  if (deps.storage && !deps.signal?.aborted) {
    const next = heldAt === undefined ? anchor : Math.min(anchor, heldAt - 1)
    if (next >= 1) await deps.storage.setItem(cursorKey, String(next))
  }
  return created
}

async function loadCursor(
  storage: Pick<IStorageAdapter, "getItem">,
  key: string,
): Promise<number | undefined> {
  const n = Number((await storage.getItem(key)) ?? NaN)
  return Number.isFinite(n) && n > 0 ? n : undefined
}
