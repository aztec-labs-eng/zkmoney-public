/**
 * ReorgNotificationProducer — in-app alerts for reorg outcomes.
 *
 * Consumes the ReorgMonitor's `ConfirmationOutcome`s. Ids are keyed (txHash,
 * outcome-kind, reorgEpoch) so `createIfAbsent` gives fire-once per episode
 * across restarts and replays — a later reorg episode (higher epoch) mints a
 * fresh alert.
 *
 * Alert semantics: `failed` / `grace-expired` → payment-failed alert, except a withdrawal's
 * `failed`, which BridgeNotificationProducer reports off the record;
 * `re-confirmed {hadAlerted:true}` → corrective notice; `exit-required` →
 * freeze notice routing to the withdrawal flow (never retry-framed);
 * `demoted`, `re-confirmed {hadAlerted:false}`, `finalized` → silence.
 */

import type { ConfirmationOutcome } from "../coordination/ReorgMonitor"

import {
  AppNotificationStore,
  type CreateAppNotificationInput,
  type ReorgNotificationTarget,
} from "./AppNotificationStore"
import type { NotificationProducer } from "./NotificationProducer"
import { logger } from "src/utils/logger"

const PRODUCER_ID = "reorg"

/** Pure outcome → notification mapping; null means no user-facing notification. */
export function reorgNotificationInput(
  outcome: ConfirmationOutcome,
  timestampMs: number,
): CreateAppNotificationInput | null {
  const hash = outcome.txHash.toLowerCase()
  const target: ReorgNotificationTarget = { type: "reorg.txDetail", txHash: outcome.txHash }
  const base = { producer: PRODUCER_ID, domain: "reorg", sourceId: hash, timestampMs, target }
  if (outcome.type === "failed" && outcome.source === "withdrawal") return null
  switch (outcome.type) {
    case "failed":
    case "grace-expired":
      return {
        ...base,
        id: `reorg:failed:${hash}:${outcome.reorgEpoch ?? 0}`,
        title: "Payment failed",
        description: outcome.incoming
          ? "This payment to you was reverted by the network and did not complete"
          : "Your transaction was reverted by the network and did not complete",
        systemIcon: "exclamationmark.triangle",
        severity: "error",
      }
    case "re-confirmed":
      if (!outcome.hadAlerted) return null
      return {
        ...base,
        id: `reorg:reconfirmed:${hash}:${outcome.reorgEpoch ?? 0}`,
        title: outcome.source === "withdrawal" ? "Withdrawal resumed" : "Payment confirmed",
        description:
          outcome.source === "withdrawal"
            ? "A withdrawal we reported as failed is on its way again"
            : "A payment we reported as failed was confirmed after all — no action needed",
        systemIcon: "checkmark.circle",
        severity: "success",
      }
    case "exit-required":
      return {
        ...base,
        id: `reorg:exit:${hash}`,
        title: "Withdrawal required",
        description:
          "The network froze before this transaction was proven. Recover the funds via the withdrawal flow",
        systemIcon: "lock.shield",
        severity: "error",
      }
    default:
      return null
  }
}

export interface ReorgNotificationProducerOptions {
  notificationStore: AppNotificationStore
  /** Optional live outcome source for `start()`; the mount instead feeds `handleOutcome` directly. */
  subscribeToOutcomes?: (listener: (outcome: ConfirmationOutcome) => void) => () => void
  /** Test seam; defaults to `Date.now`. */
  now?: () => number
}

export class ReorgNotificationProducer implements NotificationProducer {
  readonly id = PRODUCER_ID

  private static instance: ReorgNotificationProducer | null = null

  static getOrCreate(opts: ReorgNotificationProducerOptions): ReorgNotificationProducer {
    if (!ReorgNotificationProducer.instance) {
      ReorgNotificationProducer.instance = new ReorgNotificationProducer(opts)
    }
    return ReorgNotificationProducer.instance
  }

  static resetForTests(): void {
    ReorgNotificationProducer.instance?.stop()
    ReorgNotificationProducer.instance = null
  }

  private readonly opts: ReorgNotificationProducerOptions
  private readonly now: () => number
  private unsubscribe: (() => void) | null = null
  private processChain: Promise<void> = Promise.resolve()

  constructor(opts: ReorgNotificationProducerOptions) {
    this.opts = opts
    this.now = opts.now ?? Date.now
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe =
      this.opts.subscribeToOutcomes?.((outcome) => this.handleOutcome(outcome)) ?? (() => {})
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  async flush(): Promise<void> {
    await this.processChain
  }

  /** Shared entry for tracker events and the reconcile pass's `onOutcome`. */
  handleOutcome(outcome: ConfirmationOutcome): void {
    const input = reorgNotificationInput(outcome, this.now())
    if (!input) return
    this.processChain = this.processChain
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.opts.notificationStore.createIfAbsent(input)
        } catch (err) {
          logger.warn("[ReorgNotificationProducer] createIfAbsent failed:", err)
        }
      })
  }
}
