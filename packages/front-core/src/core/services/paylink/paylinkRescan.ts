/**
 * Rebuild the creator PAY rows a store lost from the account's own `Transfer` copies. The token
 * delivers each funding transfer to its sender too, and the escrow announces the link in that
 * transfer's meta, so a fresh device gets its active links back from chain plus the master secret,
 * which re-derives the creator-only refund material. Existing PAY rows are preserved; plain sends
 * from the transfer scanner are upgraded by funding tx hash. A spent escrow's row reads refunded or
 * claimed off its payout to this account (see `spentOutcome`), and that payout's plain receive
 * becomes the matching refund or claim row. A payout that turns up after its PAY row was written,
 * or was refunded on another device, settles that row on a later pass. A link whose note cannot
 * be read yet is retried on the next pass. Each pass resumes from a persisted block cursor, a
 * reorg margin behind (the store's tx-hash dedup absorbs the overlap), and the cursor never passes
 * a deferred link or PXE's synced block. Pure over injected collaborators.
 */

import type { Fr } from "@aztec/aztec.js/fields"
import { PaylinkActionEnum, TokenActionEnum } from "@obsidion/core/constants"
import type {
  PaylinkService,
  RecoveredPaylinkParams,
  ScannedTransferEvent,
  TransferEventSource,
} from "@obsidion/sdk"
import type { PaylinkTransaction } from "src/types"
import type { IStorageAdapter } from "../../storages/adapter"
import type { TransactionStorage } from "../../storages/TransactionStorage"
import {
  buildTokenInTxService,
  TRANSFER_SCAN_REORG_MARGIN,
} from "../transactions/TransferEventScanner"
import { logger } from "src/utils/logger"

const CURSOR_STORAGE_KEY = "@obsidion/paylink-rescan/cursor/v2"

export interface PaylinkRescanDeps {
  source: Pick<TransferEventSource, "headBlock" | "listIncoming" | "blockTimestampMs" | "anchorBlock">
  /** Holds the block cursor per network and account. Absent, every pass scans from `fromBlock`. */
  storage?: Pick<IStorageAdapter, "getItem" | "setItem">
  accountAddress: string
  /** The creator's master secret: re-derives each announced escrow's creator-only key material. */
  masterSecret: Fr
  /** Rollup identity of the source wallet, captured before scanning. */
  networkId: string
  /** Keys the cursor to a non-default node endpoint; absent on the default endpoint. */
  endpointScope?: string
  /** Abort when the owning account/network mount is disposed. */
  signal?: AbortSignal
  paylinkService: Pick<PaylinkService, "recoverPaylinkFromTransfer" | "isPaylinkClaimed" | "sync_note">
  /** The share URL the platform writes on a created row, so a rebuilt row opens the same way. */
  linkFor: (params: RecoveredPaylinkParams) => string | Promise<string>
  store: Pick<
    TransactionStorage,
    | "hasTxHash"
    | "findByTxHash"
    | "updateTransaction"
    | "addRecoveredPaylinkTransaction"
    | "addRecoveredPaylinkPayout"
  >
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
  const scope = deps.endpointScope ? `/${deps.endpointScope}` : ""
  const cursorKey = `${CURSOR_STORAGE_KEY}/${deps.networkId}${scope}/${me}`
  const start = deps.fromBlock ?? 1
  const cursor = deps.storage ? await loadCursor(deps.storage, cursorKey) : undefined
  // A cursor past the anchor means PXE was rebuilt or head regressed: resume from the anchor.
  const from = Math.max(start, Math.min(cursor ?? start, anchor) - TRANSFER_SCAN_REORG_MARGIN)
  if (deps.signal?.aborted) return created
  const events = [...(await deps.source.listIncoming(from, head + 1))].sort(
    (a, b) => a.blockNumber - b.blockNumber,
  )
  const payouts = new Map(
    events
      .filter((e) => e.to.toLowerCase() === me && e.from.toLowerCase() !== me)
      .map((e) => [e.from.toLowerCase(), e]),
  )
  // The oldest link whose note could not be read yet; the cursor stops short of it.
  let heldAt: number | undefined
  for (const event of events) {
    if (deps.signal?.aborted) break
    if (!event.paylinkCreated || event.from.toLowerCase() !== me) continue
    const payout = payouts.get(event.to.toLowerCase())
    if (
      (await deps.store.hasTxHash(event.txHash)) &&
      (await deps.store.findByTxHash(event.txHash))?.action !== TokenActionEnum.SEND
    ) {
      // A PAY row from an earlier pass or another device: its payout may be newer than the row.
      if (payout && !deps.signal?.aborted) await settlePayout(deps, event, payout)
      continue
    }
    if (deps.signal?.aborted) break
    const params = await deps.paylinkService.recoverPaylinkFromTransfer(event, deps.masterSecret)
    if (deps.signal?.aborted) break
    if (!params) continue
    const spent = await deps.paylinkService.isPaylinkClaimed(params)
    if (deps.signal?.aborted) break
    // A spent note is nullified: its windows no longer matter and can no longer be read.
    let note
    if (!spent) {
      try {
        note = await deps.paylinkService.sync_note(params)
      } catch (err) {
        logger.warn(`[paylinkRescan] note read deferred for ${event.txHash}:`, err)
        heldAt ??= event.blockNumber
        continue
      }
      if (deps.signal?.aborted) break
    }
    const outcome = spent ? spentOutcome(event, payout) : undefined
    const timestamp = await blockTime(deps, event.blockNumber)
    if (deps.signal?.aborted) break
    const paylink = await deps.linkFor(params)
    if (deps.signal?.aborted) break
    const { tx, inserted } = await deps.store.addRecoveredPaylinkTransaction({
      networkId: deps.networkId,
      txHash: event.txHash,
      flavor: event.paylinkCreated.flavor,
      token: usdToken(deps, event.amount),
      timestamp,
      blockNumber: event.blockNumber,
      to: params.email,
      payToEmailSecret: params.secret.toString(),
      obsidionAccountAddress: deps.accountAddress,
      tokenAddress: deps.token.address,
      paylink,
      fallbackSecret: params.fallbackSecret.toString(),
      fromClaimable: note?.claimableFrom,
      untilClaimable: note?.claimableUntil,
      refundableUntil: note?.refundableUntil,
      memo: event.memo,
      ...(outcome === "claimed" ? { isClaimed: true } : {}),
      ...(outcome === "refunded" ? { isRefunded: true, refundTxHash: payout!.txHash } : {}),
    })
    if (inserted) created.push(tx)
    if (payout && !deps.signal?.aborted) await writePayout(deps, event, payout, outcome!)
  }
  if (deps.storage && !deps.signal?.aborted) {
    const next = heldAt === undefined ? anchor : Math.min(anchor, heldAt - 1)
    if (next >= 1) await deps.storage.setItem(cursorKey, String(next))
  }
  return created
}

/**
 * How a spent escrow of this account's link was spent. No payout to this account: someone else
 * claimed it. A payout: this account refunded or claimed it itself. Both spend the same nullifier
 * and pay the same amount; what differs is the payout meta. A claim carries the verified payout
 * lane. Before that lane existed a claim only forwarded the funding transfer's memo and sender
 * tag, while a refund's meta is empty, so a payout carrying either of those is a claim too.
 */
function spentOutcome(
  funding: ScannedTransferEvent,
  payout: ScannedTransferEvent | undefined,
): "claimed" | "refunded" {
  if (!payout) return "claimed"
  if (payout.paylinkPayout) return "claimed"
  const forwarded =
    (funding.senderTag !== undefined && payout.senderTag === funding.senderTag) ||
    (funding.memo !== undefined && payout.memo === funding.memo)
  // ponytail: a pre-lane link funded with neither tag nor memo leaves nothing to forward, so its
  // self-claim reads as a refund, the creator's usual way to spend their own link.
  return forwarded ? "claimed" : "refunded"
}

/** Settles an existing PAY row against its escrow's payout; a refund flips a row that read claimed. */
async function settlePayout(
  deps: PaylinkRescanDeps,
  funding: ScannedTransferEvent,
  payout: ScannedTransferEvent,
): Promise<void> {
  const outcome = spentOutcome(funding, payout)
  const txHash = funding.txHash.toLowerCase()
  if (outcome === "refunded") {
    await deps.store.updateTransaction(
      (tx) =>
        tx.action === PaylinkActionEnum.PAY &&
        tx.txHash?.toLowerCase() === txHash &&
        !(tx as PaylinkTransaction).isRefunded &&
        !(tx as PaylinkTransaction).isMigrated,
      (tx) => {
        const row = tx as PaylinkTransaction
        row.isRefunded = true
        row.isClaimed = false
        row.refundTxHash = payout.txHash
        row.paylink = undefined
      },
    )
  }
  await writePayout(deps, funding, payout, outcome)
}

async function writePayout(
  deps: PaylinkRescanDeps,
  funding: ScannedTransferEvent,
  payout: ScannedTransferEvent,
  outcome: "claimed" | "refunded",
): Promise<void> {
  const timestamp = await blockTime(deps, payout.blockNumber)
  if (deps.signal?.aborted) return
  await deps.store.addRecoveredPaylinkPayout({
    action: outcome === "refunded" ? PaylinkActionEnum.CLAIM_BACK : PaylinkActionEnum.CLAIM,
    networkId: deps.networkId,
    txHash: payout.txHash,
    flavor: funding.paylinkCreated!.flavor,
    token: usdToken(deps, payout.amount),
    timestamp,
    blockNumber: payout.blockNumber,
    memo: payout.memo,
  })
}

async function blockTime(deps: PaylinkRescanDeps, blockNumber: number): Promise<number> {
  return (await deps.source.blockTimestampMs(blockNumber)) ?? (deps.now ?? Date.now)()
}

/** Single USD-pegged asset; the activity feed multiplies amount × price, as the create rows do. */
function usdToken(deps: PaylinkRescanDeps, rawAmount: string) {
  return { ...buildTokenInTxService({ ...deps.token, rawAmount }), price: 1 }
}

async function loadCursor(
  storage: Pick<IStorageAdapter, "getItem">,
  key: string,
): Promise<number | undefined> {
  const n = Number((await storage.getItem(key)) ?? NaN)
  return Number.isFinite(n) && n > 0 ? n : undefined
}
