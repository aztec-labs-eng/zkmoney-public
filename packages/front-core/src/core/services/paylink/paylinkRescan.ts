/**
 * Rebuild the links a store lost from the account's own `Transfer` copies. The token delivers each
 * funding transfer to its sender too, and the escrow announces the link in that transfer's meta, so
 * a fresh device gets its links back from chain plus the master secret, which re-derives the
 * creator-only refund material. A filed link is kept, and its funding transfer stays the activity
 * row the transfer scan filed, or one this pass files. A spent escrow's link reads refunded or
 * claimed off its payout to this account (see `spentOutcome`), and that payout's plain receive
 * becomes the matching refund or claim row. A payout that turns up after its link was filed, or was
 * refunded on another device, settles that link on a later pass. A link whose note cannot be read
 * yet is retried on the next pass. Each pass resumes from a persisted block cursor, a reorg margin
 * behind (the stores' dedup absorbs the overlap), and the cursor never passes a deferred link or
 * PXE's synced block. A pass saves its records and its cursor in one transaction. Pure over
 * injected collaborators.
 */

import type { Fr } from "@aztec-labs/aztec.js/fields"
import {
  PAYLINK_MIN_CLAIM_WINDOW_SECONDS,
  PaylinkActionEnum,
  TokenActionEnum,
} from "@obsidion/core/constants"
import type {
  PaylinkService,
  RecoveredPaylinkParams,
  ScannedTransferEvent,
  TransferEventSource,
} from "@obsidion/sdk"
import type { OnNetwork, PaylinkTransaction } from "../../../types"
import type { Transfers } from "../../../engine/transfers"
import type { Database, Write } from "../../../engine/database"
import { fundingOf, linkIdFor, recordOf, type Paylinks } from "../../../engine/paylinks"
import type { PaylinkRecord } from "../../../engine/paylinkTransition"
import {
  buildTokenInTxService,
  payoutRow,
  TRANSFER_SCAN_REORG_MARGIN,
} from "../transactions/TransferEventScanner"
import { logger } from "../../../utils/logger"
import {
  LEGACY_PAYLINK_RESCAN_CURSOR,
  carriedScanCursor,
} from "../../../storageMigrations/scanCursors"

const CURSOR_PREFIX = "acct/paylinkRescanCursor/"

export interface PaylinkRescanDeps {
  source: Pick<
    TransferEventSource,
    "headBlock" | "listIncoming" | "blockTimestampMs" | "anchorBlock"
  >
  /** The account's database: the records and the block cursor save in one transaction. */
  db: Database
  accountAddress: string
  /** The creator's master secret: re-derives each announced escrow's creator-only key material. */
  masterSecret: Fr
  /** Rollup identity of the source wallet, captured before scanning. */
  networkId: string
  /** Keys the cursor to a non-default node endpoint; absent on the default endpoint. */
  endpointScope?: string
  /** Abort when the owning account/network mount is disposed. */
  signal?: AbortSignal
  paylinkService: Pick<
    PaylinkService,
    "recoverPaylinkFromTransfer" | "paylinkClaimBlock" | "sync_note"
  >
  /** The share URL the platform writes on a created link, so a rebuilt one opens the same way. */
  linkFor: (params: RecoveredPaylinkParams) => string | Promise<string>
  store: Pick<Transfers, "record">
  links: Pick<Paylinks, "byHash" | "get" | "put" | "apply">
  token: { address: string; symbol: string; decimals: number }
  /** First block to scan when no cursor is stored. Default 1, the lowest PXE accepts. */
  fromBlock?: number
  /** Stands in for a funding tx whose block time cannot be read. Defaults to Date.now. */
  now?: () => number
}

export interface PaylinkRescanResult {
  /** The links filed, oldest funding tx first. */
  created: PaylinkRecord[]
  /**
   * Storage now holds every link the account made up to the node head this pass read. False when a
   * note could not be read yet or the pass was aborted.
   */
  complete: boolean
}

export async function rebuildPaylinks(deps: PaylinkRescanDeps): Promise<PaylinkRescanResult> {
  const created: PaylinkRecord[] = []
  const partial = { created, complete: false }
  if (deps.signal?.aborted) return partial
  const me = deps.accountAddress.toLowerCase()
  const head = await deps.source.headBlock()
  if (deps.signal?.aborted) return partial
  // PXE's synced block: events past it are not decryptable yet, so the cursor never passes it.
  const anchor = Math.min(head, (await deps.source.anchorBlock?.()) ?? head)
  const scope = deps.endpointScope ? `/${deps.endpointScope}` : ""
  const suffix = `${deps.networkId}${scope}/${me}`
  const cursorKey = CURSOR_PREFIX + suffix
  const start = deps.fromBlock ?? 1
  const cursor = block(
    await carriedScanCursor(deps.db, cursorKey, LEGACY_PAYLINK_RESCAN_CURSOR + suffix),
  )
  // A cursor past the anchor means PXE was rebuilt or head regressed: resume from the anchor.
  const from = Math.max(start, Math.min(cursor ?? start, anchor) - TRANSFER_SCAN_REORG_MARGIN)
  if (deps.signal?.aborted) return partial
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
  // Run by the one save at the end.
  const writes: Filing[] = []
  for (const event of events) {
    if (deps.signal?.aborted) break
    if (!event.paylinkCreated || event.from.toLowerCase() !== me) continue
    const payout = payouts.get(event.to.toLowerCase())
    if (await deps.links.byHash(event.txHash)) {
      // A link from an earlier pass or made here: its payout may be newer than the link.
      if (payout && !deps.signal?.aborted) writes.push(await settlePayout(deps, event, payout))
      continue
    }
    if (deps.signal?.aborted) break
    const params = await deps.paylinkService.recoverPaylinkFromTransfer(event, deps.masterSecret)
    if (deps.signal?.aborted) break
    if (!params) continue
    const claimBlock = await deps.paylinkService.paylinkClaimBlock(params)
    const spent = claimBlock !== undefined
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
    const claimedAt = outcome === "claimed" ? await blockTime(deps, claimBlock!) : undefined
    const refundKind =
      outcome === "refunded"
        ? refundKindOf(
            await deps.source.blockTimestampMs(event.blockNumber),
            await deps.source.blockTimestampMs(payout!.blockNumber),
          )
        : undefined
    if (deps.signal?.aborted) break
    const paylink = await deps.linkFor(params)
    if (deps.signal?.aborted) break
    const row = payRow({
      networkId: deps.networkId,
      txHash: event.txHash,
      flavor: event.paylinkCreated.flavor,
      token: usdToken(deps, event.amount),
      amountAtomic: BigInt(event.amount),
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
      // A payout to this account on a claim: this account claimed it.
      ...(outcome === "claimed"
        ? { isClaimed: true, claimedAt, claimedBy: payout ? ("self" as const) : ("chain" as const) }
        : {}),
      ...(outcome === "refunded"
        ? { isRefunded: true, refundTxHash: payout!.txHash, ...(refundKind ? { refundKind } : {}) }
        : {}),
    })
    // Keyed by the link's own params: a claimed or refunded link holds no URL to read them from.
    const link = recordOf({ ...row, networkId: row.networkId.toLowerCase() }, linkIdFor(params))
    writes.push(async (w) => {
      // A link an older build's row filed keeps its key; its funding hash names it.
      if (!(await deps.links.get(link.id, w)) && !(await deps.links.byHash(row.txHash, w))) {
        created.push(link)
        await deps.links.put(link, w)
      }
      // The funding transfer, unless the transfer scan filed it first.
      await deps.store.record(fundingOf(row), {}, w)
    })
    if (payout && !deps.signal?.aborted) {
      writes.push(await writePayout(deps, event, payout, outcome!))
    }
  }
  // An aborted pass saves nothing: its mount is gone.
  if (deps.signal?.aborted) return partial
  const next = heldAt === undefined ? anchor : Math.min(anchor, heldAt - 1)
  await deps.db.write(async (w) => {
    for (const write of writes) await write(w)
    if (next >= 1) w.put(cursorKey, String(next))
  })
  return { created, complete: !deps.signal?.aborted && heldAt === undefined }
}

/** One write of the pass's transaction. */
type Filing = (w: Write) => Promise<void>

/** A created link's row rebuilt from its funding transfer. */
function payRow(
  fields: OnNetwork<Omit<PaylinkTransaction, "id" | "action" | "emailPaymentAction" | "status">> & {
    payToEmailSecret: string
  },
): OnNetwork<PaylinkTransaction> & { payToEmailSecret: string } {
  return {
    ...fields,
    id: fields.txHash.toLowerCase(),
    action: PaylinkActionEnum.PAY,
    emailPaymentAction: PaylinkActionEnum.PAY,
    status: "success",
    isClaimed: fields.isClaimed ?? false,
    // A settled refund scrubs the link, as the refund flow does.
    ...(fields.isRefunded ? { paylink: undefined } : {}),
  }
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

/**
 * Settles a filed link against its escrow's payout: a refund flips a link that read claimed, and a
 * claim marks one that read claimed by another as this account's.
 */
async function settlePayout(
  deps: PaylinkRescanDeps,
  funding: ScannedTransferEvent,
  payout: ScannedTransferEvent,
): Promise<Filing> {
  const outcome = spentOutcome(funding, payout)
  const writePayoutRow = await writePayout(deps, funding, payout, outcome)
  const at = await blockTime(deps, payout.blockNumber)
  const refundedAt =
    outcome === "refunded" ? await deps.source.blockTimestampMs(payout.blockNumber) : undefined
  const epoch = (await deps.links.byHash(funding.txHash))?.reorgEpoch
  return async (w) => {
    const link = await deps.links.byHash(funding.txHash, w)
    if (link) {
      await deps.links.apply(
        link.id,
        outcome === "refunded"
          ? {
              type: "refunded",
              refundTxHash: payout.txHash,
              refundKind: refundKindOf(link.timestamp, refundedAt, link.untilClaimable),
            }
          : { type: "claimed", at, epoch, refundInFlight: false, by: "self" },
        w,
      )
    }
    await writePayoutRow(w)
  }
}

/**
 * An hour short of the shortest claim window, because a window starts at a chain time read before
 * its funding is proven and mined.
 */
const SURELY_CANCELLED_MS = Number(PAYLINK_MIN_CLAIM_WINDOW_SECONDS - 3_600n) * 1_000

/**
 * Which refund paid the creator back: a cancel before the link expired, a reclaim after. A spent
 * link's expiry can no longer be read, but none expires sooner than a day, so a refund sooner than
 * that was a cancel, and a later one stays unnamed. So does one whose block times the node can't
 * give: the clock standing in for them would misname it.
 */
function refundKindOf(
  fundedAt: number | undefined,
  refundedAt: number | undefined,
  untilClaimable?: number,
): PaylinkTransaction["refundKind"] {
  if (refundedAt === undefined) return undefined
  if (untilClaimable !== undefined)
    return refundedAt > untilClaimable * 1_000 ? "reclaim" : "cancel"
  if (fundedAt === undefined || refundedAt < fundedAt) return undefined
  return refundedAt - fundedAt < SURELY_CANCELLED_MS ? "cancel" : undefined
}

async function writePayout(
  deps: PaylinkRescanDeps,
  funding: ScannedTransferEvent,
  payout: ScannedTransferEvent,
  outcome: "claimed" | "refunded",
): Promise<Filing> {
  const timestamp = await blockTime(deps, payout.blockNumber)
  const row = payoutRow({
    action: outcome === "refunded" ? PaylinkActionEnum.CLAIM_BACK : PaylinkActionEnum.CLAIM,
    networkId: deps.networkId,
    txHash: payout.txHash,
    flavor: funding.paylinkCreated!.flavor,
    token: usdToken(deps, payout.amount),
    amountAtomic: BigInt(payout.amount),
    timestamp,
    blockNumber: payout.blockNumber,
    memo: payout.memo,
  })
  // Upgrades the plain receive the transfer scan filed for the payout.
  return async (w) => void (await deps.store.record(row, { replaces: TokenActionEnum.RECEIVE }, w))
}

async function blockTime(deps: PaylinkRescanDeps, blockNumber: number): Promise<number> {
  return (await deps.source.blockTimestampMs(blockNumber)) ?? (deps.now ?? Date.now)()
}

/** Single USD-pegged asset; the activity feed multiplies amount × price, as the create rows do. */
function usdToken(deps: PaylinkRescanDeps, rawAmount: string) {
  return { ...buildTokenInTxService({ ...deps.token, rawAmount }), price: 1 }
}

function block(raw: string | undefined): number | undefined {
  const n = Number(raw ?? NaN)
  return Number.isFinite(n) && n > 0 ? n : undefined
}
