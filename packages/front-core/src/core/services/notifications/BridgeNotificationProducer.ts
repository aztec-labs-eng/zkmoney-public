import {
  isBridgeActivityItem,
  withdrawalAmounts,
  type ActivityItem,
  type BridgeActivityItem,
  type WithdrawalRecord,
} from "../bridge"
import { depositAmounts } from "../deposits/depositAmounts"
import { WITHDRAWAL_PHASE_COPY } from "../bridge/withdrawalCopy"
import type { SIPADepositPhase } from "@obsidion/core/types"
import { isUnfundedSipaDeposit, type SIPADepositRecord } from "../deposits/SIPADepositStore"
import { AppNotificationStore } from "./AppNotificationStore"
import type {
  AppNotificationSeverity,
  BridgeNotificationTarget,
  CreateAppNotificationInput,
} from "./AppNotificationStore"
import { SnapshotNotificationProducer } from "./NotificationProducer"
import type { NotificationFeed, NotificationProducer } from "./NotificationProducer"
import { dollars } from "./TransferReceiveNotificationProducer"
import { logger } from "src/utils/logger"
import { AMOUNT_MAX_DECIMALS } from "src/utils/validate"
import { formatUnits, parseUnits } from "viem"

export type BridgeNotificationFeed = NotificationFeed<ActivityItem>

type TerminalBridgePhase = "done" | "failed"

/** Collapse a SIPA terminal phase onto the shared done/failed vocabulary. */
function sipaTerminalPhase(phase: SIPADepositRecord["phase"]): TerminalBridgePhase | null {
  if (phase === "claimed" || phase === "recovered") return "done"
  if (phase === "failed") return "failed"
  return null
}

/**
 * A withdrawal is terminal only at `done` (L1 payout observed), `recovered` (a swap's DAI
 * returned by the user) or `failed` (pre-mine local error). A post-mine `delayed` presentation is
 * DERIVED from a non-terminal phase, so it returns null here — no notification fires for it (a
 * false "Withdrawal failed" push on safe on-chain funds is a worse trust hit than a quiet in-app
 * delay). `recoverable` is parked on the user like a SIPA's, and stays quiet the same way.
 */
function withdrawalTerminalPhase(phase: WithdrawalRecord["phase"]): TerminalBridgePhase | null {
  if (phase === "recovered") return "done"
  return phase === "done" || phase === "failed" ? phase : null
}

/** The record's terminal phase in done/failed terms, or null when not terminal. */
function terminalPhaseForItem(item: BridgeActivityItem): TerminalBridgePhase | null {
  if (item.kind === "bridge.withdrawal") return withdrawalTerminalPhase(item.record.phase)
  return sipaTerminalPhase(item.record.phase)
}

/**
 * What the user is waiting on, per non-terminal phase. A phase absent from these maps has nothing in
 * flight — the deposit has not been funded yet (`resolved`), or it is parked waiting on the user
 * (`recoverable`), and a spinner would claim progress that is not happening. Kept short: the row
 * ellipsizes past roughly thirty characters including the amount.
 */
const SIPA_INFLIGHT: Partial<Record<SIPADepositPhase, string>> = {
  funding: "Awaiting transfer",
  funded: "Transfer received",
  broadcast: "Deposit detected",
  sweeping: "Moving into the pool",
  pendingClaim: "Crediting balance",
}

/** What a deposit's live row says it is waiting on; undefined for one not yet funded, parked, or settled. */
export function sipaDepositInflightLabel(record: SIPADepositRecord): string | undefined {
  return isUnfundedSipaDeposit(record) ? undefined : SIPA_INFLIGHT[record.phase]
}

/**
 * A withdrawal's burn before it mines is the front's own operation, which the front shows with
 * whether the tab may close; the live row starts once the chain has it.
 */
function inflightLabel(item: BridgeActivityItem, migration: boolean): string | undefined {
  if (migration) {
    if (item.kind === "bridge.withdrawal") {
      const phase = item.record.phase
      return phase === "submitting" || !WITHDRAWAL_PHASE_COPY[phase].live
        ? undefined
        : "Leaving old network"
    }
    // Funded and on its way in; before that the exit's row says where the funds are.
    return !isUnfundedSipaDeposit(item.record) && SIPA_INFLIGHT[item.record.phase]
      ? "Arriving on new network"
      : undefined
  }
  if (item.kind === "bridge.withdrawal") {
    return item.record.phase === "submitting"
      ? undefined
      : WITHDRAWAL_PHASE_COPY[item.record.phase].live
  }
  return isUnfundedSipaDeposit(item.record) ? undefined : SIPA_INFLIGHT[item.record.phase]
}

/**
 * A migration is one exit (a withdrawal record with `intent: "migration"`) and one arrival (the
 * SIPA that exit pays), reported as one move of funds rather than a withdrawal and a deposit.
 */
function migrationMatcher(items: BridgeActivityItem[]): (item: BridgeActivityItem) => boolean {
  const arrivals = new Set(
    items.flatMap((i) =>
      i.kind === "bridge.withdrawal" && i.record.intent === "migration"
        ? [i.record.recipient.toLowerCase()]
        : [],
    ),
  )
  return (item) =>
    item.kind === "bridge.withdrawal"
      ? item.record.intent === "migration"
      : arrivals.has(item.record.sipaAddress.toLowerCase())
}

/**
 * Id of the live row for a record. Distinct from the terminal id (which is keyed per completed
 * deposit) so the two never collide: the live row is dismissed as the terminal one is created.
 */
function inflightSourceId(item: BridgeActivityItem): string {
  return item.kind === "bridge.withdrawal"
    ? `bridge:withdrawal:${item.record.localId.toLowerCase()}:inflight`
    : `bridge:sipaDeposit:${item.record.sipaAddress.toLowerCase()}:inflight`
}

function inflightInput(
  item: BridgeActivityItem,
  label: string,
  migration: boolean,
): CreateAppNotificationInput {
  const id = inflightSourceId(item)
  const withdrawal = item.kind === "bridge.withdrawal"
  return {
    id,
    producer: "bridge",
    domain: "bridge",
    sourceId: id,
    title: migration
      ? "Moving funds"
      : withdrawal
      ? item.record.source === "paylink"
        ? "Paylink withdrawal in progress"
        : "Withdrawal in progress"
      : "Deposit in progress",
    description: `${amountLabel(item, migration)} · ${label}`,
    timestampMs: item.record.startTime,
    systemIcon: withdrawal ? "arrow.up.right" : "arrow.down.left",
    severity: "info",
    pending: true,
    target: targetForItem(item),
  }
}

function bridgeNotificationSourceId(item: BridgeActivityItem, phase: TerminalBridgePhase): string {
  if (item.kind === "bridge.withdrawal") {
    return `bridge:withdrawal:${item.record.localId.toLowerCase()}:${phase}`
  }
  // A re-used SIPA claims more than once; key per inbox index so each
  // completed deposit notifies once.
  return `bridge:sipaDeposit:${item.record.sipaAddress.toLowerCase()}:${
    item.record.inboxIndex ?? ""
  }:${phase}`
}

function notificationTimestamp(item: BridgeActivityItem): number | undefined {
  return item.record.endTime
}

/**
 * The figure the push names. A withdrawal names the burn, the same figure its activity row carries;
 * a deposit names what credits the balance once the fee has come off. A migration moves the
 * wallet's dollars between versions, so it reads in dollars like its rows.
 */
function amountLabel(item: BridgeActivityItem, migration: boolean): string {
  const amount = item.kind === "bridge.withdrawal" ? item.record.amount : depositFigure(item.record)
  if (migration) return dollars(Number(amount))
  // At cents like the activity row; a sweep is stamped at the deposit token's full precision.
  const cents = formatUnits(parseUnits(amount, AMOUNT_MAX_DECIMALS), AMOUNT_MAX_DECIMALS)
  return `${cents} ${item.record.tokenSymbol}`
}

/**
 * Net, except for a recovery: `recoverERC20` returns the whole balance with no fee taken, so its
 * gross is the figure.
 */
function depositFigure(record: SIPADepositRecord): string {
  const amounts = depositAmounts(record)
  return record.phase === "recovered" ? amounts.grossDisplay : amounts.netDisplay
}

function targetForItem(item: BridgeActivityItem): BridgeNotificationTarget {
  if (item.kind === "bridge.withdrawal") {
    return {
      type: "bridge.txDetail",
      bridgeKind: "withdrawal",
      sourceId: item.record.localId,
      l2TxHash: item.record.l2TxHash,
    }
  }
  // Reuses the deposit target shape; the SIPA row is keyed by its address.
  return {
    type: "bridge.txDetail",
    bridgeKind: "deposit",
    sourceId: item.record.sipaAddress.toLowerCase(),
  }
}

function titleForItem(
  item: BridgeActivityItem,
  phase: TerminalBridgePhase,
  migration: boolean,
): string {
  if (migration) return phase === "done" ? "Migration complete" : "Migration failed"
  if (item.kind === "bridge.withdrawal") {
    const what = item.record.source === "paylink" ? "Paylink withdrawal" : "Withdrawal"
    if (item.record.phase === "recovered") return `${what} recovered`
    return phase === "done" ? `${what} complete` : `${what} failed`
  }
  if (item.record.phase === "recovered") return "Deposit recovered"
  return phase === "done" ? "Deposit complete" : "Deposit failed"
}

function descriptionForItem(
  item: BridgeActivityItem,
  phase: TerminalBridgePhase,
  migration: boolean,
): string {
  if (phase === "done") {
    const amountDisplay = amountLabel(item, migration)
    if (item.record.phase === "recovered") {
      return `${amountDisplay} returned to your wallet`
    }
    return item.kind === "bridge.withdrawal"
      ? `${amountDisplay} sent to L1`
      : `${amountDisplay} arrived`
  }
  return item.record.error ?? "Tap to view details"
}

function iconForPhase(phase: TerminalBridgePhase): string {
  return phase === "done" ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
}

function severityForPhase(phase: TerminalBridgePhase): AppNotificationSeverity {
  return phase === "done" ? "success" : "error"
}

function inputForItem(
  item: BridgeActivityItem,
  phase: TerminalBridgePhase,
  migration: boolean,
): CreateAppNotificationInput {
  const id = bridgeNotificationSourceId(item, phase)
  return {
    id,
    producer: "bridge",
    domain: "bridge",
    sourceId: id,
    title: titleForItem(item, phase, migration),
    description: descriptionForItem(item, phase, migration),
    timestampMs: notificationTimestamp(item)!,
    systemIcon: iconForPhase(phase),
    severity: severityForPhase(phase),
    target: targetForItem(item),
  }
}

export interface BridgeNotificationOptions {
  /**
   * Also mint a live row per in-flight record, retired when it settles. Opt-in: a retired row is
   * dismissed rather than deleted, so a client whose list does not filter `dismissedAt` would keep
   * it forever beside the completion row.
   */
  liveRows?: boolean
}

export class BridgeNotificationProducer implements NotificationProducer {
  private static instance: BridgeNotificationProducer | null = null
  private notifications: AppNotificationStore
  private runner: SnapshotNotificationProducer<ActivityItem>
  private liveRows: boolean
  private hasSeenBridgeItems = false
  readonly id = "bridge"

  constructor(
    feed: BridgeNotificationFeed,
    notifications: AppNotificationStore,
    options: BridgeNotificationOptions = {},
  ) {
    this.notifications = notifications
    this.liveRows = options.liveRows ?? false
    this.runner = new SnapshotNotificationProducer<ActivityItem>({
      id: this.id,
      feed,
      label: "BridgeNotificationProducer",
      process: (items, baselineMs) => this.process(items, baselineMs),
    })
  }

  static get(
    feed?: BridgeNotificationFeed,
    notifications?: AppNotificationStore,
    options?: BridgeNotificationOptions,
  ): BridgeNotificationProducer {
    if (!BridgeNotificationProducer.instance) {
      if (!feed || !notifications) {
        throw new Error(
          "First call to BridgeNotificationProducer.get() requires feed and notification store",
        )
      }
      BridgeNotificationProducer.instance = new BridgeNotificationProducer(
        feed,
        notifications,
        options,
      )
    }
    return BridgeNotificationProducer.instance
  }

  static resetForTests(): void {
    BridgeNotificationProducer.instance?.stop()
    BridgeNotificationProducer.instance = null
  }

  start(): void {
    this.runner.start()
  }

  stop(): void {
    this.runner.stop()
  }

  async flush(): Promise<void> {
    await this.runner.flush()
  }

  /**
   * Live rows for everything still in flight, and a dismiss for every live row that no longer is.
   * The survivor set is read back off the store rather than tracked in memory, so a row left behind
   * by a previous page load is retired too.
   */
  private async syncLiveRows(
    items: BridgeActivityItem[],
    isMigration: (item: BridgeActivityItem) => boolean,
  ): Promise<void> {
    // Preserve restored rows during initial loading. Once records have appeared, an empty
    // snapshot means the last record was removed (for example, a cancelled withdrawal).
    if (items.length) this.hasSeenBridgeItems = true
    if (!this.hasSeenBridgeItems) return
    await this.notifications.load()
    const stillFlying = new Set<string>()
    for (const item of items) {
      const migration = isMigration(item)
      const label = inflightLabel(item, migration)
      if (!label) continue
      // No baseline gate: a deposit that started before this session is still worth a live row.
      stillFlying.add(inflightSourceId(item))
      try {
        await this.notifications.upsert(inflightInput(item, label, migration))
      } catch (err) {
        logger.warn("[BridgeNotificationProducer] failed to update in-flight notification:", err)
      }
    }
    for (const entry of this.notifications.list()) {
      if (entry.producer !== "bridge" || !entry.pending || stillFlying.has(entry.id)) continue
      await this.notifications.dismiss(entry.id).catch(() => {})
    }
  }

  private async process(items: ActivityItem[], baseline: number): Promise<void> {
    const bridgeItems = items.filter(isBridgeActivityItem)
    const isMigration = migrationMatcher(bridgeItems)
    if (this.liveRows) await this.syncLiveRows(bridgeItems, isMigration)

    for (const item of bridgeItems) {
      const phase = terminalPhaseForItem(item)
      if (!phase) continue
      const migration = isMigration(item)
      // A migration's exit is half of one move; its arrival reports the move.
      if (migration && item.kind === "bridge.withdrawal" && phase === "done") continue

      const endTime = notificationTimestamp(item)
      if (endTime == null) {
        logger.warn("[BridgeNotificationProducer] terminal bridge record missing endTime:", {
          kind: item.kind,
          phase,
          id: item.kind === "bridge.withdrawal" ? item.record.localId : item.record.sipaAddress,
        })
        continue
      }
      if (endTime < baseline) continue

      try {
        await this.notifications.createIfAbsent(inputForItem(item, phase, migration))
      } catch (err) {
        logger.warn("[BridgeNotificationProducer] failed to create notification:", err)
      }
    }
  }
}
