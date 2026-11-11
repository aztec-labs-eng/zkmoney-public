import {
  bestEffort,
  type ReportedPhases,
  type WithdrawFunnel,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import { fireEvent, type AnalyticsEvent, type AnalyticsProps } from "../../lib/analytics"

/**
 * L1-leg funnel reporting for withdrawals. The tracker's phases and timestamps live in the
 * persisted record (`phaseEnteredAt` = when finalizing_l1 began, untouched by the `done` patch;
 * `endTime` = terminal stamp), so durations survive reloads — an L1 wait typically outlives the
 * tab. What must NOT survive twice is the report itself, so each record's reported phase is saved,
 * keyed by its random localId, in the write that decides what to emit. Only phase names and
 * durations are emitted — never the recipient, amount, or any hash.
 */

/** Phases past the L1 release: the finalization the funnel measures has happened. */
const RELEASED: ReadonlySet<WithdrawalRecord["phase"]> = new Set<WithdrawalRecord["phase"]>([
  "done",
  "swapping",
  "bridging",
  "recoverable",
  "recovered",
])

/** What a withdrawal record's burn pays for, as the exit events' `kind` reports it. */
export function withdrawKind(r: WithdrawalRecord): "withdraw" | "savings" | "paylink" {
  return r.skyMove ? "savings" : r.source === "paylink" ? "paylink" : "withdraw"
}

/** A user's own cash-out. A legacy split withdrawal counts once, by its funds leg. */
const isUserWithdrawal = (r: WithdrawalRecord) =>
  withdrawKind(r) === "withdraw" && !r.intent && r.groupLeg !== "gas"

export interface FunnelEvent {
  event: Extract<AnalyticsEvent, `withdraw_final${string}`>
  props: AnalyticsProps
}

function readyProps(r: WithdrawalRecord): AnalyticsProps {
  return {
    since_confirm_ms: r.phaseEnteredAt !== undefined ? r.phaseEnteredAt - r.startTime : undefined,
  }
}

function finalizedProps(r: WithdrawalRecord): AnalyticsProps {
  return {
    l1_wait_ms:
      r.endTime !== undefined && r.phaseEnteredAt !== undefined
        ? r.endTime - r.phaseEnteredAt
        : undefined,
    total_ms: r.endTime !== undefined ? r.endTime - r.startTime : undefined,
  }
}

/**
 * Events owed for the current records against what was already reported. A `done` record that was
 * never seen entering finalizing_l1 (tab closed through the whole L1 leg) reports both steps at
 * once — the record's timestamps carry the durations regardless of when we look.
 */
export function withdrawTransitions(
  records: readonly WithdrawalRecord[],
  reported: ReportedPhases,
): { events: FunnelEvent[]; next: ReportedPhases } {
  const events: FunnelEvent[] = []
  const next: ReportedPhases = {}
  for (const r of records) {
    // A rescan's timestamps are the burn's, not this session's: nothing to measure.
    if (r.rebuilt || !isUserWithdrawal(r)) continue
    const prior = reported[r.localId]
    if (r.phase === "finalizing_l1") {
      if (prior === undefined)
        events.push({ event: "withdraw_finalization_ready", props: readyProps(r) })
      next[r.localId] = "finalizing_l1"
    } else if (RELEASED.has(r.phase)) {
      if (prior === undefined)
        events.push({ event: "withdraw_finalization_ready", props: readyProps(r) })
      if (prior !== "done") events.push({ event: "withdraw_finalized", props: finalizedProps(r) })
      next[r.localId] = "done"
    } else if (prior !== undefined) {
      // Reorg demoted the record below finalizing_l1 — keep the mark so re-entry doesn't re-report.
      next[r.localId] = prior
    }
  }
  return { events, next }
}

/** Diff the records against their saved phases, save the new ones, and emit what's owed once saved. */
export async function reportWithdrawFunnel(
  records: readonly WithdrawalRecord[],
  funnel: WithdrawFunnel,
): Promise<void> {
  const events = await bestEffort(
    "unknown",
    funnel.report(
      records.map((r) => r.localId),
      (reported) => withdrawTransitions(records, reported),
    ),
  )
  for (const e of events ?? []) fireEvent(e.event, e.props)
}
