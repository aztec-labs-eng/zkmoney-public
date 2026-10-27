import {
  isBridgeActivityItem,
  isWithdrawalGroupTerminal,
  withdrawalAmounts,
  withdrawalGroupAmount,
  withdrawalGroupTime,
  withdrawalGroupsOf,
  worstWithdrawalPhase,
  type ActivityItem,
  type BridgeActivityItem,
  type WithdrawalGroup,
  type WithdrawalRecord,
} from "../bridge"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { formatUnits } from "viem"
import { depositAmounts } from "../deposits/depositAmounts"
import { WITHDRAWAL_PHASE_COPY } from "../bridge/withdrawalCopy"
import { savingsMoveLabel } from "../savings/savingsMoveCopy"
import { depositPhaseCopy } from "../deposits/depositCopy"
import { isAccountMoveSipa, type SIPADepositRecord } from "../deposits/SIPADepositStore"
import { SIPA_PROCESSING_COPY, sipaReasonShown } from "../deposits/sipaProcessing"
import { AppNotificationStore } from "./AppNotificationStore"
import type {
  AppNotificationSeverity,
  BridgeNotificationTarget,
  CreateAppNotificationInput,
} from "./AppNotificationStore"
import { SnapshotNotificationProducer } from "./NotificationProducer"
import type { NotificationFeed, NotificationProducer } from "./NotificationProducer"
import { upgradeBatchArrived } from "../../migration/upgradeActivity"
import { upgradeRunsOf, type UpgradeRun } from "../../migration/upgradeRuns"
import { dollars } from "./TransferReceiveNotificationProducer"
import { isNativeEth } from "../../../oxide/sipaFunding"
import { logger } from "src/utils/logger"
import { tokenAmount } from "src/utils/tokenAmount"

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
 * What a deposit's live row says it is waiting on; undefined for one not yet funded, parked, or
 * settled, where a spinner would claim progress that is not happening.
 */
export function sipaDepositInflightLabel(record: SIPADepositRecord): string | undefined {
  return depositPhaseCopy(record).live
}

/** Phases a rebuilt withdrawal sits in until the tracker has seen its L1 release. */
const UNRELEASED: ReadonlySet<WithdrawalRecord["phase"]> = new Set([
  "l2_mined",
  "awaiting_proven",
  "finalizing_l1",
])

/**
 * A withdrawal's burn before it mines is the front's own operation, which the front shows with
 * whether the tab may close; the live row starts once the chain has it. A deposit waiting for a
 * sweep says why when `sipaReasonShown`, in the words its activity row and detail sheet use. A
 * record rebuilt from chain starts at the burn: its release was never observed here, so until the
 * tracker sees it spent on L1 a live row would report an old, settled withdrawal as in progress.
 */
function inflightLabel(item: BridgeActivityItem): string | undefined {
  if (item.kind === "bridge.sipaDeposit" && sipaReasonShown(item.processing, item.record)) {
    return SIPA_PROCESSING_COPY[item.processing.reason.kind].short
  }
  if (
    item.kind === "bridge.withdrawal" &&
    item.record.rebuilt &&
    UNRELEASED.has(item.record.phase)
  ) {
    return undefined
  }
  if (item.kind === "bridge.withdrawal") {
    return item.record.phase === "submitting"
      ? undefined
      : WITHDRAWAL_PHASE_COPY[item.record.phase].live
  }
  return sipaDepositInflightLabel(item.record)
}

/**
 * A group as one withdrawal item on its lead leg (the failed one, else funds, else gas), so the
 * pair reports once through the single-record paths.
 */
function groupAsItem(group: WithdrawalGroup): BridgeActivityItem {
  const legs = [group.legs.gas, group.legs.funds].filter((r): r is WithdrawalRecord => !!r)
  const over = (records: WithdrawalRecord[]): WithdrawalGroup => ({ ...group, legs: {}, records })
  const terminal = isWithdrawalGroupTerminal(group)
  const failed = terminal ? legs.find((r) => r.phase === "failed") : undefined
  const lead = failed ?? group.legs.funds ?? group.legs.gas ?? group.records[0]
  // A submitting leg is the front's own operation; the least advanced leg on chain names the row.
  const live = legs.filter((r) => r.phase !== "submitting" && WITHDRAWAL_PHASE_COPY[r.phase].live)
  const shown = terminal ? group : over(live)
  const phase = terminal || live.length ? worstWithdrawalPhase(shown) : "submitting"
  // Only what was recovered came back; a leg that paid out is not returned.
  const amount = withdrawalGroupAmount(
    phase === "recovered" ? over(legs.filter((r) => r.phase === "recovered")) : group,
  )
  const startTime = Math.min(...group.records.map((r) => r.startTime))
  const endTime = terminal ? withdrawalGroupTime(group) : undefined
  return { kind: "bridge.withdrawal", record: { ...lead, phase, amount, startTime, endTime } }
}

/**
 * A migration is one exit (a withdrawal record with `intent: "migration"`, or an upgrade's refund
 * batch) and one arrival (the SIPA that exit pays), reported as one move of funds rather than a
 * withdrawal and a deposit. A SIPA the account pays itself is an arrival on its own.
 */
function migrationMatcher(
  items: BridgeActivityItem[],
  upgradeArrivals: readonly string[],
): (item: BridgeActivityItem) => boolean {
  const arrivals = new Set([
    ...items.flatMap((i) =>
      i.kind === "bridge.withdrawal" && i.record.intent === "migration"
        ? [i.record.recipient.toLowerCase()]
        : [],
    ),
    ...upgradeArrivals,
  ])
  return (item) =>
    item.kind === "bridge.withdrawal"
      ? item.record.intent === "migration"
      : isAccountMoveSipa(item.record) || arrivals.has(item.record.sipaAddress.toLowerCase())
}

/** A grouped leg keys its rows by its group, so the pair keeps one live row across the hand-off. */
function withdrawalSourceKey(record: WithdrawalRecord): string {
  return record.groupId
    ? `withdrawal-group:${record.groupId.toLowerCase()}`
    : `withdrawal:${record.localId.toLowerCase()}`
}

/**
 * Id of the live row for a record. Distinct from the terminal id (which is keyed per completed
 * deposit) so the two never collide: the live row is dismissed as the terminal one is created.
 */
function inflightSourceId(item: BridgeActivityItem): string {
  return item.kind === "bridge.withdrawal"
    ? `bridge:${withdrawalSourceKey(item.record)}:inflight`
    : `bridge:sipaDeposit:${item.record.sipaAddress.toLowerCase()}:inflight`
}

/** The burn of a Savings move, whose words are the move's rather than a withdrawal's. */
const savingsMoveOf = (item: BridgeActivityItem) =>
  item.kind === "bridge.withdrawal" ? item.record.skyMove : undefined

function inflightInput(
  item: BridgeActivityItem,
  label: string,
  migration: boolean,
): CreateAppNotificationInput {
  const id = inflightSourceId(item)
  const withdrawal = item.kind === "bridge.withdrawal"
  const savings = savingsMoveOf(item)
  return {
    id,
    producer: "bridge",
    domain: "bridge",
    sourceId: id,
    title: migration
      ? "Upgrading"
      : savings
      ? savingsMoveLabel(savings.direction)
      : withdrawal
      ? item.record.source === "paylink"
        ? "Paylink withdrawal in progress"
        : "Withdrawal in progress"
      : "Deposit in progress",
    description: savings ? amountLabel(item) : `${amountLabel(item)} · ${label}`,
    timestampMs: item.record.startTime,
    systemIcon: withdrawal ? "arrow.up.right" : "arrow.down.left",
    severity: "info",
    pending: true,
    target: targetForItem(item),
  }
}

function upgradeRunInput(
  run: UpgradeRun,
  done: boolean,
  value: bigint | undefined,
): CreateAppNotificationInput {
  const figure = value === undefined ? "—" : dollars(Number(formatUnits(value, DEFAULT_DECIMALS)))
  // Funds that reach the old version later join the run: its larger whole reports anew. An
  // inferred run's legs join as discovery finds them, so it keeps one report.
  const count = run.inferred ? "" : `:${run.legs.length}`
  const id = `migration-run:${run.run}${done ? `:done${count}` : ""}`
  const n = run.legs.length
  return {
    id,
    producer: "bridge",
    domain: "bridge",
    sourceId: id,
    title: done ? "Upgrade complete" : "Upgrading",
    description: done
      ? `${figure} · ${n === 1 ? "1 transfer" : `${n} transfers`}`
      : `${figure} · ${run.arrived} of ${n} arrived`,
    timestampMs: done
      ? Math.max(...run.legs.map((leg) => leg.arrival?.endTime ?? 0))
      : Math.min(...run.legs.map((leg) => leg.batch.startTime)),
    systemIcon: done ? iconForPhase("done") : "arrow.down.left",
    severity: done ? severityForPhase("done") : "info",
    ...(done ? {} : { pending: true }),
    target: { type: "upgrade.run", run: run.run },
  }
}

function bridgeNotificationSourceId(item: BridgeActivityItem, phase: TerminalBridgePhase): string {
  if (item.kind === "bridge.withdrawal") {
    // A grouped leg sent again after a failure is a new record, so its failure reports anew.
    const leg =
      item.record.groupId && phase === "failed" ? `:${item.record.localId.toLowerCase()}` : ""
    return `bridge:${withdrawalSourceKey(item.record)}:${phase}${leg}`
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
 * The figure the push names, in the dollars the balance is in: a withdrawal names its burn, a
 * deposit what credits the balance once the fee has come off. ETH sent to a deposit address is
 * named in ETH.
 */
function amountLabel(item: BridgeActivityItem): string {
  const savings = savingsMoveOf(item)
  // A move out burns sUSDS shares, never named as a count: their dollar value, else the route.
  if (savings?.direction === "out")
    return savings.value === undefined
      ? "From Savings"
      : dollars(Number(formatUnits(BigInt(savings.value), DEFAULT_DECIMALS)))
  if (item.kind === "bridge.withdrawal") return dollars(Number(item.record.amount))
  const figure = depositFigure(item.record)
  return isNativeEth(item.record.tokenAddress)
    ? `${tokenAmount(figure)} ETH`
    : dollars(Number(figure))
}

/**
 * Net, except for a recovery: `recoverERC20` returns the whole balance with no fee taken, so its
 * gross is the figure. A swapped deposit's amounts are in its row token's units, not the funded token's.
 */
function depositFigure(record: SIPADepositRecord): string {
  const amounts = depositAmounts(record, record.rowToken ? undefined : record.tokenDecimals)
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
  if (migration && item.record.phase !== "recovered")
    return phase === "done" ? "Upgrade complete" : "Upgrade failed"
  const savings = savingsMoveOf(item)
  if (savings) return phase === "done" ? savingsMoveLabel(savings.direction) : "Move failed"
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
    const amountDisplay = amountLabel(item)
    if (item.record.phase === "recovered") {
      return `${amountDisplay} returned to your wallet`
    }
    // The move's release is in; the move itself finishes when the destination claims the deposit.
    if (savingsMoveOf(item)) return amountDisplay
    return item.kind === "bridge.withdrawal"
      ? `${amountDisplay} sent to Ethereum`
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
  /** Dollar value of the destination assets; undefined while their denomination or price is unknown. */
  upgradeValue?(run: UpgradeRun): bigint | undefined
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
  private upgradeValue: (run: UpgradeRun) => bigint | undefined
  private hasSeenBridgeItems = false
  readonly id = "bridge"

  constructor(
    feed: BridgeNotificationFeed,
    notifications: AppNotificationStore,
    options: BridgeNotificationOptions = {},
  ) {
    this.notifications = notifications
    this.liveRows = options.liveRows ?? false
    this.upgradeValue = options.upgradeValue ?? ((run) => run.total)
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
    } else if (options?.upgradeValue) {
      BridgeNotificationProducer.instance.upgradeValue = options.upgradeValue
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

  async refresh(): Promise<void> {
    await this.runner.refresh()
  }

  /**
   * Live rows for everything still in flight, and a dismiss for every live row that no longer is.
   * The survivor set is read back off the store rather than tracked in memory, so a row left behind
   * by a previous page load is retired too.
   */
  private async syncLiveRows(
    items: BridgeActivityItem[],
    isMigration: (item: BridgeActivityItem) => boolean,
    runs: UpgradeRun[],
  ): Promise<void> {
    // Preserve restored rows until the feed has loaded; from then on an empty snapshot means the
    // last record was removed (a cancelled withdrawal) or is another producer's to carry.
    if (!this.hasSeenBridgeItems) return
    await this.notifications.load()
    const stillFlying = new Set<string>()
    for (const item of items) {
      const migration = isMigration(item)
      const label = inflightLabel(item)
      if (!label) continue
      // No baseline gate: a deposit that started before this session is still worth a live row.
      stillFlying.add(inflightSourceId(item))
      try {
        await this.notifications.upsert(inflightInput(item, label, migration))
      } catch (err) {
        logger.warn("[BridgeNotificationProducer] failed to update in-flight notification:", err)
      }
    }
    // An upgrade is one live row until every batch has arrived.
    for (const run of runs) {
      if (run.settled) continue
      const input = upgradeRunInput(run, false, this.upgradeValue(run))
      stillFlying.add(input.id)
      await this.notifications.upsert(input).catch((err) => {
        logger.warn("[BridgeNotificationProducer] failed to update an upgrade's live row:", err)
      })
    }
    for (const entry of this.notifications.list()) {
      if (entry.producer !== "bridge" || !entry.pending || stillFlying.has(entry.id)) continue
      await this.notifications.dismiss(entry.id).catch(() => {})
    }
  }

  /**
   * A withdrawal that failed and is no longer failed loses its failed entry, so a later failure
   * reports anew, and its dismissed live row, so the next sync shows it. A reorg failure alert
   * for its burn goes too. A failed leg that a later record of the same leg replaced is retired
   * with it.
   */
  private async retireRecovered(withdrawals: WithdrawalRecord[]): Promise<void> {
    await this.notifications.load()
    const replaced = new Set(
      withdrawalGroupsOf(withdrawals).flatMap((group) =>
        group.records
          .filter((r) => r.groupLeg && group.legs[r.groupLeg]?.localId !== r.localId)
          .map((r) => r.localId),
      ),
    )
    for (const record of withdrawals) {
      // A group that names no leg keys its failed entry by its first record, failed or not.
      if (record.groupId && !record.groupLeg) continue
      if (record.phase === "failed" && !replaced.has(record.localId)) continue
      const item: BridgeActivityItem = { kind: "bridge.withdrawal", record }
      const failed = bridgeNotificationSourceId(item, "failed")
      if (!this.notifications.get(failed)) continue
      await this.notifications.remove(failed)
      const live = this.notifications.get(inflightSourceId(item))
      if (live?.dismissedAt) await this.notifications.remove(live.id)
    }
    // Matched by burn: the id holds the failure's epoch, and a revived record's is a later one.
    const alerts = this.notifications.list().filter((e) => e.id.startsWith("reorg:failed:"))
    if (!alerts.length) return
    // A registration burn rides a claim's transaction, and that alert is the claim's.
    const burns = new Set(
      withdrawals
        .filter((r) => r.phase !== "failed" && r.intent !== "registration")
        .map((r) => r.l2TxHash?.toLowerCase()),
    )
    for (const alert of alerts) {
      if (burns.has(alert.sourceId)) await this.notifications.remove(alert.id)
    }
  }

  private async process(items: ActivityItem[], baseline: number): Promise<void> {
    const allBridgeItems = items.filter(isBridgeActivityItem)
    // Readiness is read off every bridge record, before the exclusion below: a wallet whose only
    // bridge activity is its registration deposit still retires the stored live row for it.
    if (allBridgeItems.length || items.some((i) => i.kind === "upgrade.batch"))
      this.hasSeenBridgeItems = true
    const withdrawals = allBridgeItems.flatMap((i) =>
      i.kind === "bridge.withdrawal" ? [i.record] : [],
    )
    // A registration's deposit and the burn that funds it (a ticket signup's claim) are carried
    // by RegistrationNotificationProducer as one claim story. Excluding both here is what stops a
    // duplicate row for the deposit, and what stops the funding burn reading as a cash-out
    // withdrawal to Ethereum. Each fresh-address group stands in for its legs. A backup passkey
    // rotation's deposit address and the burn that funds it are followed by the settings panel
    // that drives them, not by the bell.
    const bridgeItems = allBridgeItems
      .filter(
        (item) =>
          item.record.intent !== "registration" &&
          !(item.kind === "bridge.withdrawal" && item.record.groupId) &&
          !(item.kind === "bridge.withdrawal" && item.record.intent === "backup") &&
          !(item.kind === "bridge.sipaDeposit" && item.record.intent === "user-op"),
      )
      .concat(withdrawalGroupsOf(withdrawals).map(groupAsItem))
    const runs = upgradeRunsOf(items)
    // An upgrade's deposits are its run's: the run reports them, save a failure of one.
    const runArrivals = new Set(
      runs.flatMap((run) => run.legs.map((leg) => leg.batch.recipient.toLowerCase())),
    )
    const ofRun = (item: BridgeActivityItem) =>
      item.kind === "bridge.sipaDeposit" && runArrivals.has(item.record.sipaAddress.toLowerCase())
    const isMigration = migrationMatcher(bridgeItems, [...runArrivals])
    await this.retireRecovered(withdrawals)
    if (this.liveRows)
      await this.syncLiveRows(
        bridgeItems.filter((item) => !ofRun(item)),
        isMigration,
        runs,
      )

    // The upgrade is complete only once no run is still to arrive or approved and unsent.
    const upgrading =
      runs.some((run) => !run.settled) ||
      items.some(
        (i) => i.kind === "upgrade.batch" && i.batch.state === "planned" && i.batch.approved,
      )
    for (const run of runs) {
      if (!run.complete || upgrading) continue
      const value = this.upgradeValue(run)
      if (value === undefined) continue
      const input = upgradeRunInput(run, true, value)
      // A deposit claimed from a replayed sweep takes the sweep's time: a run seen pending reports.
      // An inferred run reads as pending while discovery claims its history, so only time counts.
      const seenPending = !run.inferred && !!this.notifications.get(`migration-run:${run.run}`)
      if (input.timestampMs < baseline && !seenPending) continue
      const report: Promise<unknown> = run.inferred
        ? this.notifications.upsert(input)
        : this.notifications.createIfAbsent(input)
      await report.catch((err) => {
        logger.warn("[BridgeNotificationProducer] failed to report an upgrade:", err)
      })
    }

    for (const item of bridgeItems) {
      const phase = terminalPhaseForItem(item)
      if (!phase) continue
      if (phase === "done" && ofRun(item) && upgradeBatchArrived(item.record as SIPADepositRecord))
        continue
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
      // A reorg can drop the burn while this producer is stopped (wallet locked mid-pass), and
      // nothing else reports it; createIfAbsent keeps the replay to one alert.
      const reorgDropped = item.kind === "bridge.withdrawal" && item.record.droppedBurn
      if (endTime < baseline && !reorgDropped) continue

      try {
        await this.notifications.createIfAbsent(inputForItem(item, phase, migration))
      } catch (err) {
        logger.warn("[BridgeNotificationProducer] failed to create notification:", err)
      }
    }
  }
}
