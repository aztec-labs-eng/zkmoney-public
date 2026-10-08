/**
 * TransferEventScanner — the chain-native source of the account's L2 transfer history.
 *
 * Polls the wallet's own private `Transfer` events from a persisted block cursor and writes a
 * verified row per event: a `receive` when the account is `to`, a `send` when it is `from` (the
 * token delivers every transfer to both parties, so a fresh client rebuilds what it sent too), and
 * a paylink claim row when the source verified the event's payout lane.
 * Nothing arrives off-chain: the sender's tag (and memo / request id) ride the event's `meta`, and
 * the tag is display attribution only — it is kept when the name registry resolves it to the
 * on-chain `from`, else the row shows the raw address and no contact is auto-added. Sends keep the
 * recipient L2 address so contact history can match it and resolve its display name; the recipient
 * tag the sender wrote into its own event copy is adopted as a contact under the same registry
 * check, against the on-chain `to`. Every downstream consumer
 * (`incomingTransfer` → notifications, balance refresh, request reconciler, reorg anchoring via
 * `blockNumber`) hangs off the receive insert; sends only land in the store.
 *
 * Scans run in chunks of at most `MAX_BLOCKS_PER_TICK`; the cursor advances per completed chunk, so
 * a failure retries only its own chunk, never the whole history. Only a pass's first chunk syncs
 * PXE; the rest read at its anchor, since each new anchor wipes the token's note discovery. The
 * cursor never persists past the source's `anchorBlock` (PXE's synced block): head is the node tip,
 * but `listIncoming` only sees what PXE has decrypted, and PXE lags whenever a send pins the sync —
 * advancing to head would skip every block in the gap. The anchor is sampled BEFORE each list: it
 * is monotone, so a pre-read never exceeds the list's true coverage, while a post-read could claim
 * blocks a mid-tick sync added that the list never saw. While the anchor trails head the tick keeps
 * rescanning instead of idling, which re-triggers the very sync that advances the anchor. An anchor
 * below the cursor means PXE was rebuilt (store wipe, generation change) — the cursor rewinds to it
 * so the re-decrypted blocks are rescanned, just like a head that regressed below the cursor. A
 * registry outage holds the chunk's cursor so the range is retried; after `MAX_INGEST_ATTEMPTS`
 * failures the registry lookup — the only shed-able dependency — is dropped and the row is written
 * with the raw sender address, because PXE already validated the event itself: it must be recorded,
 * never skipped. Each tick rescans `REORG_MARGIN` blocks behind the cursor (the store's txHash
 * dedup makes that free).
 *
 * Every await that leaves the device is bounded by a timeout, so no hung RPC or registry fetch can
 * wedge the tick latch. A catch-up read gets a longer bound: a fresh device's first note discovery
 * can outlast the normal one, and a timed-out read keeps running in PXE's queue ahead of its retry.
 * Consecutive failed ticks back off exponentially. While head is static the tick skips the scan
 * entirely — `headBlock` is a plain node read but `listIncoming` drags a full PXE sync behind it —
 * with a periodic full pass so a static-head rebuild is still caught.
 *
 * Snapshot sources return events and balance from one validated PXE anchor. `onSynced` publishes
 * the snapshot before event attribution/persistence, so their failures cannot withhold a balance.
 * A throwing hook fails the tick (backoff, full rescan next tick).
 */

import type { IStorageAdapter } from "../../storages/adapter"
import type { TokenInTxService } from "../../../types/tokens"
import type { ScannedTransferEvent, TransferEventSource, WalletSyncSource } from "@obsidion/sdk"
import type {
  ContactsByL2,
  ITagForwardResolver,
  TransactionStoreWrites,
} from "../../../xmtp/receiverTypes"
import { globalEventEmitter } from "../GlobalEventEmitter"
import { logger } from "src/utils/logger"
import { PaylinkActionEnum } from "@obsidion/core/constants"

export type { ScannedTransferEvent, TransferEventSource }

const LOG_PREFIX = "[TransferEventScanner]"
export const TRANSFER_SCAN_POLL_INTERVAL_MS = 5_000
export const TRANSFER_SCAN_REORG_MARGIN = 64
export const TRANSFER_SCAN_MAX_BLOCKS_PER_TICK = 10_000
/** Cursor lag that hides a pass behind the activity skeleton: a rebuild or a gap of many hours, not a reopen. */
export const TRANSFER_SCAN_CATCH_UP_BLOCKS = 1_000
export const TRANSFER_SCAN_SOURCE_TIMEOUT_MS = 30_000
export const TRANSFER_SCAN_CATCH_UP_TIMEOUT_MS = 300_000
const MAX_BACKOFF_MS = 60_000
const CURSOR_STORAGE_KEY = "@obsidion/transfer-scan/cursor/v1"
const JOINED_STORAGE_KEY = "@obsidion/transfer-scan/joined/v1"
/** Failed ingests for one txHash before attribution degrades to the raw sender address. */
const MAX_INGEST_ATTEMPTS = 3
/** Full rescan cadence while head is static, so a reorg that rebuilt without advancing head lands. */
const IDLE_TICKS_PER_FULL_PASS = 12

type ScanScope = Pick<TransferScanContext, "accountAddress" | "networkId">

function cursorKey(ctx: ScanScope & Pick<TransferScanContext, "endpointScope">): string {
  const scope = ctx.endpointScope ? `/${ctx.endpointScope}` : ""
  return `${CURSOR_STORAGE_KEY}/${ctx.networkId}${scope}/${ctx.accountAddress.toLowerCase()}`
}

function joinedKey(ctx: ScanScope): string {
  return `${JOINED_STORAGE_KEY}/${ctx.networkId}/${ctx.accountAddress.toLowerCase()}`
}

async function loadBlock(storage: IStorageAdapter, key: string): Promise<number | undefined> {
  const raw = await storage.getItem(key)
  const n = raw === null ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * Where this device first scanned the account: head, and the wall clock then. A transfer at or
 * below that block AND stamped before that time is history the device replayed; a block a later
 * reorg replaced at that height is stamped after it, so it still reads as news. Absent on a device
 * that scanned before the record was kept, which hides nothing.
 */
export interface TransferScanJoined {
  block: number
  ms: number
}

export async function loadTransferScanJoined(
  storage: IStorageAdapter,
  ctx: ScanScope,
): Promise<TransferScanJoined | undefined> {
  const raw = await storage.getItem(joinedKey(ctx))
  if (raw === null) return undefined
  try {
    const { block, ms } = JSON.parse(raw) as Partial<TransferScanJoined>
    return typeof block === "number" && typeof ms === "number" ? { block, ms } : undefined
  } catch {
    return undefined
  }
}

export interface TransferScanContext {
  accountAddress: string
  /** Display identity written to the row's `to`. */
  accountTag: string
  networkId: string
  /**
   * Keys the cursor to a non-default node endpoint, so its scans never move the cursor the
   * default endpoint resumes from. Absent on the default endpoint.
   */
  endpointScope?: string
}

export interface TransferEventScannerOptions {
  source: TransferEventSource & Partial<Pick<WalletSyncSource, "readSnapshot">>
  storage: IStorageAdapter
  transactionStore: TransactionStoreWrites
  tags: ITagForwardResolver
  contacts: ContactsByL2
  token: { address: string; symbol: string; decimals: number }
  /** Publishes each chunk's validated snapshot before event attribution or persistence. */
  onSynced?: (anchorBlock: number, balance?: bigint) => Promise<void>
  pollIntervalMs?: number
  sourceTimeoutMs?: number
  catchUpTimeoutMs?: number
  scheduler?: {
    setTimeout: (cb: () => void, ms: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
  now?: () => number
}

export class TransferEventScanner {
  private readonly opts: TransferEventScannerOptions
  private readonly pollIntervalMs: number
  private readonly sourceTimeoutMs: number
  private readonly catchUpTimeoutMs: number
  private readonly scheduler: NonNullable<TransferEventScannerOptions["scheduler"]>
  private readonly now: () => number
  private context: TransferScanContext | undefined
  private running = false
  private inFlight: Promise<void> | null = null
  /** Passes started; lets an explicit tick tell whether a pass began after it was requested. */
  private passes = 0
  private consecutiveFailures = 0
  private timer: unknown
  /** Failed ingest attempts per txHash; at `MAX_INGEST_ATTEMPTS` the ingest goes degraded. */
  private readonly ingestAttempts = new Map<string, number>()
  private lastScannedHead: number | undefined
  private idleTicks = 0
  /** Held while a pass rebuilds history: no cursor, or cursor more than `TRANSFER_SCAN_CATCH_UP_BLOCKS` behind head. */
  private endCatchUp: (() => void) | null = null

  constructor(options: TransferEventScannerOptions) {
    this.opts = options
    this.pollIntervalMs = options.pollIntervalMs ?? TRANSFER_SCAN_POLL_INTERVAL_MS
    this.sourceTimeoutMs = options.sourceTimeoutMs ?? TRANSFER_SCAN_SOURCE_TIMEOUT_MS
    this.catchUpTimeoutMs = options.catchUpTimeoutMs ?? TRANSFER_SCAN_CATCH_UP_TIMEOUT_MS
    this.scheduler = options.scheduler ?? {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    }
    this.now = options.now ?? Date.now
  }

  async start(context: TransferScanContext): Promise<void> {
    if (this.running) this.stop()
    this.context = context
    this.running = true
    await this.tickNow()
  }

  stop(): void {
    this.running = false
    this.context = undefined
    this.clearTimer()
    this.endCatchUp?.()
    this.endCatchUp = null
  }

  /**
   * Scan once now. Always a full pass — an explicit tick is a foreground resume or a
   * pull-to-refresh, where skipping the reorg-margin rescan is exactly the wrong call; only the
   * background timer idles down. A tick already in flight is awaited first, then one more pass
   * runs (shared by every explicit caller that queued behind it), so the returned promise never
   * resolves before a pass that started after the request completed.
   */
  async tickNow(): Promise<void> {
    const wanted = this.passes + 1
    while (this.inFlight) await this.inFlight
    if (this.passes >= wanted) return
    this.idleTicks = IDLE_TICKS_PER_FULL_PASS
    return this.runTick()
  }

  private runTick(): Promise<void> {
    if (!this.running || !this.context || this.inFlight) return Promise.resolve()
    this.passes++
    this.inFlight = this.tick().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async tick(): Promise<void> {
    if (!this.context) return
    this.clearTimer()
    const ctx = this.context
    let ok = false
    try {
      ok = await this.scan(ctx)
    } catch (err) {
      logger.warn(`${LOG_PREFIX} scan failed:`, err)
    } finally {
      // ponytail: one pass, complete or not, ends the catch-up; a partial history then lands live.
      this.endCatchUp?.()
      this.endCatchUp = null
      this.consecutiveFailures = ok ? 0 : this.consecutiveFailures + 1
      // Reschedule off CURRENT state, not the captured ctx: a restart mid-tick (new context
      // object) must still get its next tick, else the scanner silently stops.
      if (this.running && this.context !== undefined) {
        this.timer = this.scheduler.setTimeout(() => void this.runTick(), this.nextDelayMs())
      }
    }
  }

  private nextDelayMs(): number {
    if (this.consecutiveFailures === 0) return this.pollIntervalMs
    return Math.min(this.pollIntervalMs * 2 ** this.consecutiveFailures, MAX_BACKOFF_MS)
  }

  /** Returns true when every chunk up to head completed (cursor at head). */
  private async scan(ctx: TransferScanContext): Promise<boolean> {
    const head = await this.bounded(this.opts.source.headBlock(), "headBlock")
    let cursor = await this.loadCursor(ctx)
    if (
      cursor === undefined &&
      (await loadTransferScanJoined(this.opts.storage, ctx)) === undefined
    ) {
      const joined: TransferScanJoined = { block: head, ms: this.now() }
      await this.opts.storage.setItem(joinedKey(ctx), JSON.stringify(joined))
    }

    // A head behind the cursor means the chain was rebuilt shorter than the margin reaches. Pull
    // the cursor back to the surviving head, else the blocks between them are never rescanned and
    // a transfer re-included on the new chain is lost for good.
    if (cursor !== undefined && head < cursor) {
      logger.warn(`${LOG_PREFIX} head ${head} regressed below cursor ${cursor}; rewinding`)
      await this.saveCursor(ctx, head)
      cursor = head
    }

    let anchor = await this.readAnchor(head)
    // PXE rebuilt below the cursor: rewind so its re-decrypted blocks are rescanned.
    if (cursor !== undefined && anchor < cursor) {
      logger.warn(`${LOG_PREFIX} anchor ${anchor} below cursor ${cursor}; rewinding`)
      await this.saveCursor(ctx, anchor)
      cursor = anchor
    }

    let from = Math.max(1, Math.min(cursor ?? 1, head) - TRANSFER_SCAN_REORG_MARGIN)
    if (head < from) return true

    // `headBlock` is a plain node read; `listIncoming` drags a full PXE sync behind it. While head
    // is static there is nothing new to decrypt, so skip the sync and let the tick idle.
    if (head === this.lastScannedHead && this.idleTicks < IDLE_TICKS_PER_FULL_PASS) {
      this.idleTicks++
      return true
    }
    this.idleTicks = 0

    // Catching up: rows from this pass land behind the activity skeleton, released when the pass ends.
    if (cursor === undefined || head - cursor > TRANSFER_SCAN_CATCH_UP_BLOCKS) {
      this.endCatchUp ??= globalEventEmitter.beginSyncCatchUp()
    }

    const readTimeoutMs = this.endCatchUp ? this.catchUpTimeoutMs : this.sourceTimeoutMs
    let synced = false
    while (from <= head) {
      // A stale ctx (stop/restart mid-tick) aborts without counting as a failure.
      if (!this.running || this.context !== ctx) return true
      const chunkEnd = Math.min(from + TRANSFER_SCAN_MAX_BLOCKS_PER_TICK - 1, head)
      const snapshot = this.opts.source.readSnapshot
        ? await this.bounded(
            this.opts.source.readSnapshot(
              from,
              chunkEnd + 1,
              synced ? { assumeSynced: true } : undefined,
            ),
            "readSnapshot",
            readTimeoutMs,
          )
        : {
            events: await this.bounded(
              this.opts.source.listIncoming(from, chunkEnd + 1),
              "listIncoming",
              readTimeoutMs,
            ),
            anchorBlock: await this.readAnchor(head),
            balance: undefined,
          }
      synced = true
      if (!this.running || this.context !== ctx) return true
      anchor = snapshot.anchorBlock
      // Publish the balance before attribution or persistence can defer an event. The bounded
      // snapshot has no side effects: a late result after timeout/stop can never publish here.
      const balanceComplete = await this.synced(ctx, anchor, snapshot.balance)
      const complete = await this.ingestEvents(ctx, snapshot.events)
      if (!this.running || this.context !== ctx) return true
      if (!complete || !balanceComplete) return false
      const scannedTo = Math.min(chunkEnd, anchor)
      if (scannedTo >= from) await this.saveCursor(ctx, scannedTo)
      if (anchor < chunkEnd) return true // next tick rescans and re-syncs
      from = chunkEnd + 1
    }
    this.lastScannedHead = head
    return true
  }

  /** Runs the post-sync hook; a failure fails the tick and forces a full pass next time. */
  private async synced(
    ctx: TransferScanContext,
    anchor: number,
    balance?: bigint,
  ): Promise<boolean> {
    if (!this.opts.onSynced || !this.running || this.context !== ctx) return true
    try {
      await this.bounded(this.opts.onSynced(anchor, balance), "onSynced")
      return true
    } catch (err) {
      logger.warn(`${LOG_PREFIX} onSynced failed:`, err)
      this.lastScannedHead = undefined
      return false
    }
  }

  private readAnchor(head: number): Promise<number> {
    if (!this.opts.source.anchorBlock) return Promise.resolve(head)
    return this.bounded(this.opts.source.anchorBlock(), "anchorBlock")
  }

  private async ingestEvents(
    ctx: TransferScanContext,
    events: ScannedTransferEvent[],
  ): Promise<boolean> {
    let complete = true
    for (const event of events) {
      if (!this.running || this.context !== ctx) return false
      const action = this.direction(event, ctx)
      if (!action) continue
      const attempts = this.ingestAttempts.get(event.txHash) ?? 0
      try {
        await this.ingest(event, ctx, action, attempts >= MAX_INGEST_ATTEMPTS)
        this.ingestAttempts.delete(event.txHash)
      } catch (err) {
        // Hold the cursor and retry; repeated failures shed the registry lookup, never the event.
        this.ingestAttempts.set(event.txHash, attempts + 1)
        complete = false
        logger.warn(
          `${LOG_PREFIX} ingest deferred for ${event.txHash} (attempt ${attempts + 1}):`,
          err,
        )
      }
    }
    return complete
  }

  private bounded<T>(
    promise: Promise<T>,
    label: string,
    timeoutMs: number = this.sourceTimeoutMs,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      )
      promise.then(
        (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        (err) => {
          clearTimeout(timer)
          reject(err)
        },
      )
    })
  }

  /** Self-transfers and events of other accounts are neither. */
  private direction(
    event: ScannedTransferEvent,
    ctx: TransferScanContext,
  ): "send" | "receive" | undefined {
    const me = ctx.accountAddress.toLowerCase()
    const from = event.from.toLowerCase()
    const to = event.to.toLowerCase()
    if (from === to) return undefined
    if (to === me) return "receive"
    if (from === me) return "send"
    return undefined
  }

  private async ingest(
    event: ScannedTransferEvent,
    ctx: TransferScanContext,
    action: "send" | "receive",
    degraded: boolean,
  ): Promise<void> {
    // A verified payout lane: the escrow paid this account's claim. No sender to attribute, and no
    // hash check: the write upgrades a plain receive filed before the lane was read and is a no-op
    // on any other row, so a claim row is never duplicated.
    if (
      action === "receive" &&
      event.paylinkPayout &&
      this.opts.transactionStore.addRecoveredPaylinkPayout
    ) {
      const timestamp = await this.timestampOf(event)
      if (!this.running || this.context !== ctx) return
      const written = await this.opts.transactionStore.addRecoveredPaylinkPayout({
        action: PaylinkActionEnum.CLAIM,
        txHash: event.txHash,
        flavor: event.paylinkPayout.flavor,
        token: buildTokenInTxService({ ...this.opts.token, rawAmount: event.amount }),
        timestamp,
        blockNumber: event.blockNumber,
        memo: event.memo,
        networkId: ctx.networkId,
      })
      if (written) logger.log(`${LOG_PREFIX} paylink claim ${event.txHash}`)
      return
    }

    // Any row already carrying this hash, not just a send/receive: the paylink escrow pays the
    // claimant with the same token `transfer`, so a claim or refund arrives here as a `Transfer`
    // to us. Matching only send/receive would file it a second time as a stranger receive. It is
    // also what keeps a send this client made itself from being filed twice. The payout carries the
    // creator's memo, which a claim or refund row written before the tx mined does not have yet.
    if (await this.opts.transactionStore.hasTxHash(event.txHash)) {
      if (event.memo) await this.opts.transactionStore.backfillMemo?.(event.txHash, event.memo)
      return
    }

    const counterparty =
      action === "receive"
        ? await this.bounded(this.attributeSender(event, ctx, degraded), "attributeCounterparty")
        : event.to
    if (action === "send") {
      await this.bounded(this.adoptRecipient(event, ctx, degraded), "adoptRecipient")
    }
    const timestamp = await this.timestampOf(event)
    // The awaits above can outlive a stop/restart or network switch; never write under a stale ctx.
    if (!this.running || this.context !== ctx) return
    const { inserted } = await this.opts.transactionStore.addIncomingTokenTransaction({
      action,
      txHash: event.txHash,
      from: action === "receive" ? counterparty : ctx.accountTag,
      senderL2Address: event.from,
      to: action === "receive" ? ctx.accountTag : counterparty,
      token: buildTokenInTxService({ ...this.opts.token, rawAmount: event.amount }),
      timestamp,
      memo: event.memo,
      blockNumber: event.blockNumber,
      requestId: event.requestId,
      amountAtomic: event.amount,
      networkId: ctx.networkId,
    })
    if (inserted) logger.log(`${LOG_PREFIX} ${action} ${event.txHash} ${counterparty}`)
  }

  /**
   * PXE decrypted this block, so the node has it; a missing header is transient. The row's date is
   * permanent (the store dedups by hash), so defer and retry rather than stamp the clock.
   */
  private async timestampOf(event: ScannedTransferEvent): Promise<number> {
    const timestamp = await this.bounded(
      this.opts.source.blockTimestampMs(event.blockNumber),
      "blockTimestampMs",
    )
    if (timestamp === undefined) throw new Error(`block ${event.blockNumber} time unavailable`)
    return timestamp
  }

  /**
   * Display attribution: a saved contact's tag wins; else the claimed tag, only when the registry
   * resolves it to the on-chain sender (then auto-added as a contact); else the raw address.
   * A resolver transport failure throws so the caller defers — unless `degraded`, which skips the
   * registry entirely and settles for the raw address after repeated deferrals.
   */
  private async attributeSender(
    event: ScannedTransferEvent,
    ctx: TransferScanContext,
    degraded: boolean,
  ): Promise<string> {
    const contact = await this.opts.contacts.findByL2Address(event.from).catch(() => null)
    if (contact?.tag) return contact.tag
    if (!event.senderTag || degraded) return event.from
    const adopted = await this.adoptTag(event.senderTag, event.from, ctx)
    return adopted ? event.senderTag : event.from
  }

  /**
   * The sender's mirror of `attributeSender`: the recipient tag it wrote into its own event copy
   * becomes a contact once the registry resolves it to the on-chain `to`. The row keeps the raw
   * address either way; contact history resolves the display name from it.
   */
  private async adoptRecipient(
    event: ScannedTransferEvent,
    ctx: TransferScanContext,
    degraded: boolean,
  ): Promise<void> {
    if (!event.recipientTag || degraded) return
    const contact = await this.opts.contacts.findByL2Address(event.to).catch(() => null)
    if (contact?.tag) return
    await this.adoptTag(event.recipientTag, event.to, ctx)
  }

  /** Registers `tag` as a contact when the registry resolves it to `l2Address`; throws on transport failure. */
  private async adoptTag(
    tag: string,
    l2Address: string,
    ctx: TransferScanContext,
  ): Promise<boolean> {
    const resolved = await this.opts.tags.resolveL2(tag, ctx.networkId)
    if (!resolved || resolved.l2Address.toLowerCase() !== l2Address.toLowerCase()) {
      logger.warn(`${LOG_PREFIX} tag "${tag}" does not resolve to ${l2Address}; using address`)
      return false
    }
    await this.opts.contacts
      .registerL2?.({ tag, l2Address })
      .catch((err) => logger.warn(`${LOG_PREFIX} contact auto-add failed:`, err))
    return true
  }

  private loadCursor(ctx: TransferScanContext): Promise<number | undefined> {
    return loadBlock(this.opts.storage, cursorKey(ctx))
  }

  private async saveCursor(ctx: TransferScanContext, head: number): Promise<void> {
    await this.opts.storage.setItem(cursorKey(ctx), String(head))
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      this.scheduler.clearTimeout(this.timer)
      this.timer = undefined
    }
  }
}

/** Row token for a verified receive; the display amount follows the send path's `Number` model. */
export function buildTokenInTxService(args: {
  address: string
  symbol: string | undefined
  decimals: number
  rawAmount: string
}): TokenInTxService {
  const symbol = args.symbol?.trim() || "?"
  return {
    address: args.address,
    name: symbol,
    symbol,
    decimals: args.decimals,
    logo: "",
    amount: rawToDisplay(args.rawAmount, args.decimals),
    price: 0,
  }
}

function rawToDisplay(rawAmount: string, decimals: number): number {
  let raw: bigint
  try {
    raw = BigInt(rawAmount)
  } catch {
    return 0
  }
  if (decimals <= 0) return Number(raw)
  const divisor = 10n ** BigInt(decimals)
  return Number(raw / divisor) + Number(raw % divisor) / Number(divisor)
}
