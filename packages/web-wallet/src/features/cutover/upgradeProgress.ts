/** Where a run stands, as the Upgrading page draws it (Figma 389:31309). */
import type { MetadataMigrationPhase, MetadataMigrationRecord } from "@obsidion/front-core"
import { upgradingCopy } from "./cutoverCopy"

export interface UpgradeRing {
  percent: number
  caption: string
}

/**
 * The ring's figure and caption for a run's phase; before the sends, its share of approvals. Its
 * first caption names the step under way: the account's update while `updating`, else the withdrawal.
 */
export function upgradeProgress(
  phase: MetadataMigrationPhase | undefined,
  approvals?: { approved: number; total: number },
  updating = false,
): UpgradeRing {
  const first = updating ? upgradingCopy.updating : upgradingCopy.withdrawing
  switch (phase) {
    case undefined:
    case "preparing":
    case "needsApproval":
    case "needsAttention": {
      const share = approvals?.total ? approvals.approved / approvals.total : 0
      return { percent: 1 + Math.round(30 * share), caption: first }
    }
    case "broadcasting":
      return { percent: 33, caption: first }
    case "awaitingMessages":
      return { percent: 38, caption: upgradingCopy.left(3) }
    case "waiting":
      return { percent: 50, caption: upgradingCopy.left(3) }
    case "subscribing":
      return { percent: 60, caption: upgradingCopy.left(2) }
    case "recovering":
      return { percent: 70, caption: upgradingCopy.left(2) }
    case "arriving":
      return { percent: 85, caption: upgradingCopy.left(2) }
    default:
      return { percent: 100, caption: upgradingCopy.left(0) }
  }
}

/**
 * An upgrade's ring over all its runs: their share of the upgrade's `approvals` until each has approved,
 * then the mean of their figures, captioned by the run furthest behind. The queue runs one source at a
 * time, so one run's phase alone jumps back as the next starts.
 */
export function queueProgress(
  runs: readonly (Pick<MetadataMigrationRecord, "phase" | "approvals"> | null)[],
  approvals?: { approved: number; total: number },
  updating = false,
): UpgradeRing {
  if (runs.some((run) => !run || run.phase === "preparing" || run.phase === "needsApproval"))
    return upgradeProgress(undefined, approvals, updating)
  const rings = runs.map((run) => upgradeProgress(run!.phase, run!.approvals, updating))
  const behind = rings.reduce((a, b) => (b.percent < a.percent ? b : a))
  const mean = rings.reduce((sum, ring) => sum + ring.percent, 0) / rings.length
  return { percent: Math.round(mean), caption: behind.caption }
}

export type UpgradeStepState = "done" | "active" | "todo"

/** How far a run is past the account's update, which its funds wait for: sending, arriving, done. */
const STAGE: Partial<Record<MetadataMigrationPhase, number>> = {
  recovering: 1,
  arriving: 2,
  done: 3,
}

/**
 * The Upgrading page's steps over an upgrade's runs, in the order they happen: the account's update,
 * then the old versions' withdrawal, then the deposit. `updated`: no run has to update the account.
 */
export function upgradeSteps(
  phases: readonly (MetadataMigrationPhase | undefined)[],
  updated: boolean,
): [UpgradeStepState, UpgradeStepState, UpgradeStepState] {
  const stages = phases.map((phase) => (phase && STAGE[phase]) ?? 0)
  const update = updated || stages.some((s) => s >= 1)
  const sent = update && stages.every((s) => s >= 2)
  const done = sent && stages.every((s) => s >= 3)
  return [
    update ? "done" : "active",
    sent ? "done" : update ? "active" : "todo",
    done ? "done" : sent ? "active" : "todo",
  ]
}
