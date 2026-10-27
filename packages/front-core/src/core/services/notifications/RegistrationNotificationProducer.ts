/**
 * RegistrationNotificationProducer — carries a tag registration through the notification bell.
 *
 * The registration deposit is its own story: a name is being bought, not funds arriving, so it gets
 * one live row that tracks the claim rather than the generic bridge rows (which are excluded for
 * `intent: "registration"` deposits and burns so the two never both show). The row updates in
 * place through the in-flight stages and settles once the name is registered:
 *
 *   1. awaiting the deposit — silent, no row (the activation hero already asks for it)
 *   2. funding — a ticket signup's claim is burning the link's payment to the deposit address
 *   3. deposit received
 *   4. sweeping the deposit
 *   5. claiming the tag
 *   6. crediting the balance on L2
 *   → registered (settles; the one stage that toasts)
 *
 * The stage is read from the pending-registration record, its SIPA deposit's rail phase and any
 * withdrawal burning to its address, so the row advances as any of those stores change. `upsert`
 * keeps it one row; the terminal is a separate id so it toasts fresh even if the live row was
 * already read. Before the sweep, a stated processing reason replaces the stage copy, by the rule
 * and in the words of the deposit's other surfaces.
 */
import type { Address } from "viem"
import type { PendingRegistrationRecord } from "../registration/PendingRegistrationStore"
import { PendingRegistrationStore } from "../registration/PendingRegistrationStore"
import {
  depositOwed,
  registrationStage,
  type RegistrationStage,
} from "../registration/registrationStage"
import { SIPADepositStore } from "../deposits/SIPADepositStore"
import type { SIPADepositRecord } from "../deposits/SIPADepositStore"
import type { WithdrawalStorage } from "../bridge/WithdrawalStorage"
import { SIPA_PROCESSING_COPY, sipaReasonShown } from "../deposits/sipaProcessing"
import type { SipaProcessingState } from "../deposits/sipaProcessing"
import { STUCK_SWEEP_MS } from "../deposits/sipaStuck"
import type { SipaProcessingSource } from "../bridge/BridgeActivityFeed"
import type {
  AppNotificationStore,
  BridgeNotificationTarget,
  CreateAppNotificationInput,
} from "./AppNotificationStore"
import type { NotificationProducer } from "./NotificationProducer"
import { logger } from "src/utils/logger"

const PRODUCER_ID = "registration"

/** While the deposit is owed the activation hero asks for it and the bell stays quiet. */
type LiveStage = Exclude<RegistrationStage, "reserved" | "registered" | "failed">

function inflightCopy(stage: LiveStage, tag: string): { title: string; description: string } {
  switch (stage) {
    case "funding":
      return { title: "Claiming your tag", description: `Securing @${tag}` }
    case "received":
      return { title: "Deposit received", description: `Securing @${tag}` }
    case "sweeping":
      return { title: "Sweeping deposit", description: "Moving your funds into the pool" }
    case "claiming":
      return { title: `Claiming @${tag}`, description: "Registering your tag" }
    case "crediting":
      return { title: "Crediting your balance", description: "Adding your funds on Aztec" }
  }
}

// Keyed by the name, not just the account: a wallet whose account registers a second name (a retry
// on a different tag after a failure) gets its own live and terminal rows, so a later outcome never
// adopts the earlier one's id.
const liveId = (record: PendingRegistrationRecord) =>
  `registration:${record.account.toLowerCase()}:${record.nameHash.toLowerCase()}:live`
const terminalId = (record: PendingRegistrationRecord) =>
  `registration:${record.account.toLowerCase()}:${record.nameHash.toLowerCase()}`

// In flight or failed, the row leads back to the claim. Registered, there is nothing left to claim:
// the row opens the deposit's own activity detail, as the bridge producer's row for it would.
const registrationTarget = (tag: string) => ({ type: "registration.pending", tag })
const registeredTarget = (record: PendingRegistrationRecord): BridgeNotificationTarget => ({
  type: "bridge.txDetail",
  bridgeKind: "deposit",
  sourceId: record.sipaAddress.toLowerCase(),
})

function liveInput(
  record: PendingRegistrationRecord,
  stage: LiveStage,
  reason?: SipaProcessingState,
): CreateAppNotificationInput {
  const { title, description } = reason
    ? { title: "Deposit received", description: SIPA_PROCESSING_COPY[reason.reason.kind].short }
    : inflightCopy(stage, record.tag)
  return {
    id: liveId(record),
    producer: PRODUCER_ID,
    domain: "registration",
    sourceId: record.sipaAddress.toLowerCase(),
    title,
    description,
    timestampMs: record.fundedAt ?? record.startTime,
    systemIcon: "arrow.down.left",
    severity: "info",
    pending: true,
    target: registrationTarget(record.tag),
  }
}

function terminalInput(
  record: PendingRegistrationRecord,
  stage: "registered" | "failed",
  nowMs: number,
): CreateAppNotificationInput {
  const registered = stage === "registered"
  return {
    id: terminalId(record),
    producer: PRODUCER_ID,
    domain: "registration",
    sourceId: record.sipaAddress.toLowerCase(),
    title: registered ? `@${record.tag} is registered` : "Registration needs attention",
    description: registered ? "Your tag is ready to use" : `Check on @${record.tag}`,
    timestampMs: record.endTime ?? nowMs,
    systemIcon: registered ? "checkmark.circle" : "exclamationmark.triangle",
    severity: registered ? "success" : "error",
    target: registered ? registeredTarget(record) : registrationTarget(record.tag),
  }
}

export interface RegistrationNotificationProducerOptions {
  notificationStore: Pick<
    AppNotificationStore,
    "upsert" | "createIfAbsent" | "dismiss" | "setTarget"
  >
  pendingStore: Pick<PendingRegistrationStore, "list" | "onListChanged">
  sipaStore: Pick<SIPADepositStore, "get" | "onListChanged">
  /** The burns this wallet sends; one to the registration's address is the funding stage. */
  withdrawalStore?: Pick<WithdrawalStorage, "list" | "onListChanged">
  /** The active wallet's L2 address; the record whose `l2Address` matches is the one carried. */
  currentAccount: () => string | null
  /** Why the deposit still waits for its sweep; without it the row keeps the stage copy. */
  processing?: SipaProcessingSource
  /** Test seam; defaults to `Date.now`. */
  now?: () => number
}

export class RegistrationNotificationProducer implements NotificationProducer {
  readonly id = PRODUCER_ID

  private static instance: RegistrationNotificationProducer | null = null

  static getOrCreate(
    opts: RegistrationNotificationProducerOptions,
  ): RegistrationNotificationProducer {
    if (!RegistrationNotificationProducer.instance) {
      RegistrationNotificationProducer.instance = new RegistrationNotificationProducer(opts)
    }
    return RegistrationNotificationProducer.instance
  }

  static resetForTests(): void {
    RegistrationNotificationProducer.instance?.stop()
    RegistrationNotificationProducer.instance = null
  }

  private readonly opts: RegistrationNotificationProducerOptions
  private readonly now: () => number
  private unsubscribes: Array<() => void> = []
  private processChain: Promise<void> = Promise.resolve()
  /** No store write marks the stuck clock at which a waiting reason starts being stated. */
  private wake: ReturnType<typeof setTimeout> | undefined

  constructor(opts: RegistrationNotificationProducerOptions) {
    this.opts = opts
    this.now = opts.now ?? Date.now
  }

  start(): void {
    if (this.unsubscribes.length) return
    const react = () => this.enqueue()
    this.unsubscribes.push(this.opts.pendingStore.onListChanged(react))
    this.unsubscribes.push(this.opts.sipaStore.onListChanged(react))
    if (this.opts.withdrawalStore) {
      this.unsubscribes.push(this.opts.withdrawalStore.onListChanged(react))
    }
    if (this.opts.processing) this.unsubscribes.push(this.opts.processing.subscribe(react))
    this.enqueue()
  }

  stop(): void {
    for (const off of this.unsubscribes) off()
    this.unsubscribes = []
    clearTimeout(this.wake)
    this.wake = undefined
  }

  async flush(): Promise<void> {
    await this.processChain
  }

  private enqueue(): void {
    this.processChain = this.processChain.catch(() => undefined).then(() => this.process())
  }

  private async process(): Promise<void> {
    clearTimeout(this.wake)
    this.wake = undefined
    const address = this.opts.currentAccount()
    if (!address) return
    const record = this.opts.pendingStore
      .list()
      .find((r) => r.l2Address.toLowerCase() === address.toLowerCase())
    if (!record) return
    const deposit = this.opts.sipaStore.get(record.sipaAddress as Address)
    const burns = this.opts.withdrawalStore?.list() ?? []
    const stage = registrationStage(record, { deposit, burns })
    const reason =
      stage === "received" || stage === "sweeping" ? this.reasonFor(deposit) : undefined
    try {
      if (depositOwed(stage)) {
        // Nothing left to report: a funding burn that was cancelled or failed, or a refunded
        // deposit, takes its live row with it.
        await this.opts.notificationStore.dismiss(liveId(record))
        return
      }
      if (stage === "registered" || stage === "failed") {
        await this.opts.notificationStore.dismiss(liveId(record))
        const { entry, created } = await this.opts.notificationStore.createIfAbsent(
          terminalInput(record, stage, this.now()),
        )
        // A registered row stored with the claim target still leads to the wizard, which has nothing
        // left to show for it. It is retargeted where it stands: same id, so it does not toast again.
        if (!created && stage === "registered" && entry.target.type === "registration.pending") {
          await this.opts.notificationStore.setTarget(entry.id, registeredTarget(record))
        }
        return
      }
      await this.opts.notificationStore.upsert(liveInput(record, stage, reason))
    } catch (err) {
      logger.warn("[RegistrationNotificationProducer] failed to write notification:", err)
    }
  }

  /** The deposit's stated reason, if any; wakes at the stuck clock when a reason waits for it. */
  private reasonFor(
    deposit: SIPADepositRecord | null | undefined,
  ): SipaProcessingState | undefined {
    if (!deposit) return undefined
    const state = this.opts.processing?.stateFor(deposit.sipaAddress)
    const now = this.now()
    if (sipaReasonShown(state, deposit, now)) return state
    const due = deposit.startTime + STUCK_SWEEP_MS
    const sweepPending = deposit.phase === "sweeping" || deposit.phase === "broadcast"
    // A pass queued before `stop()` still runs; a stopped producer arms nothing.
    if (state && sweepPending && due > now && this.unsubscribes.length > 0) {
      this.wake = setTimeout(() => this.enqueue(), due - now)
    }
    return undefined
  }
}
