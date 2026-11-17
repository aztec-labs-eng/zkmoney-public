/**
 * Backup passkey funnel reporters, consented only: the cards, the sheet's screens and taps, each
 * step a saved attempt reaches, and Account history's check and move. No event carries an address,
 * an exact amount, a hash or an attempt id.
 *
 * An add spans page loads and its sheet can close, so the steps an attempt reaches are reported from
 * its saved record, each once, marked in the account's backup funnel.
 */
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import {
  bestEffort,
  recoveryState,
  type BackupFunnel,
  type BackupFunnelMark,
  type BackupFunnelMarks,
  type BackupRotationPhase,
  type BackupRotationRecord,
} from "@obsidion/front-core"
import type { BackupAddChoice } from "@obsidion/passkey-web"
import {
  amountBucket,
  fireEvent,
  type AnalyticsEvent,
  type AnalyticsProps,
} from "../../lib/analytics"
import { firstInTab } from "../../lib/trafficSource"
import { lap } from "../registration/registrationFunnel"
import type { WithdrawalSpeed } from "../withdraw/WithdrawalSpeedPicker"
import type { AccountHistory } from "./accountHistory"
import { charged, type BackupFailure } from "./backupFailure"
import type { EntryAction, EntryCondition } from "./backupPasskeyEntry"
import type { HomeNudge } from "./backupReminder"
import {
  blockedScreen,
  type BackupAddState,
  type BackupDelay,
  type BackupScreenId,
  type CancelFrom,
} from "./backupScreen"
import type { PreviousMoveOutcome } from "./previousAccountWatcher"
import type { SheetKind, SheetMove } from "./screens/FailedScreen/failedSheet"

/** `"<n>"` below `top`, then `"<top>+"`. */
const upTo = (n: number, top: number) => (n >= top ? `${top}+` : String(n))

const approvalsBucket = (n: number) => (n <= 1 ? "1" : n <= 3 ? "2-3" : "4+")

// ── Cards ──

export type NudgeSurface = "home" | "settings"

const NUDGE_KINDS: Record<HomeNudge["kind"], string> = {
  oneKey: "one_key",
  oneDevice: "one_device",
  resume: "resume",
  adding: "adding",
  finish: "finish",
  moveFunds: "move_funds",
}

const DOLLAR = 10n ** BigInt(DEFAULT_DECIMALS)

function thresholdBucket(threshold: bigint): string {
  if (threshold >= 100_000n * DOLLAR) return "100k+"
  if (threshold >= 10_000n * DOLLAR) return "10k"
  if (threshold >= 1_000n * DOLLAR) return "1k"
  return "100"
}

const nudgeProps = (surface: NudgeSurface, nudge: HomeNudge): AnalyticsProps => ({
  surface,
  kind: NUDGE_KINDS[nudge.kind],
  ...(nudge.kind === "oneKey" && { threshold: thresholdBucket(nudge.threshold) }),
})

/** A card showed: once per tab per surface and kind. */
export function reportNudgeShown(surface: NudgeSurface, nudge: HomeNudge): void {
  if (firstInTab(`backup_nudge_shown:${surface}:${nudge.kind}`))
    fireEvent("backup_nudge_shown", nudgeProps(surface, nudge))
}

export function reportNudgeExit(
  surface: NudgeSurface,
  nudge: HomeNudge,
  control: "open" | "not_now",
): void {
  fireEvent("backup_nudge_exit", { ...nudgeProps(surface, nudge), control })
}

// ── The sheet ──

/** What opened the Passkeys sheet. */
export type SheetFrom = "home_card" | "settings_card" | "settings_row" | "activity"

const SCREENS: Partial<Record<BackupScreenId, string>> = {
  keys: "keys",
  blocked: "blocked",
  lowBalance: "low_balance",
  unavailable: "unavailable",
  firstPasskey: "first_passkey",
  unreadable: "unreadable",
  approve: "approve",
  adding: "adding",
  finish: "finish",
  done: "done",
  recovery: "recovery",
  failed: "failed",
}

/** Reports the sheet settled on `screen`; false for a screen it does not report, as loading. */
export function reportSheetOpened(from: SheetFrom, screen: BackupScreenId): boolean {
  const shown = SCREENS[screen]
  if (!shown) return false
  fireEvent("backup_sheet_opened", { from, screen: shown })
  return true
}

/** The screen a held add opens. */
const HELD: Partial<Record<BackupScreenId, string>> = {
  blocked: "blocked",
  lowBalance: "low_balance",
  unavailable: "unavailable",
  firstPasskey: "first_passkey",
}

const BLOCKS: Record<EntryCondition["id"], string> = {
  firstPasskey: "first_passkey",
  registered: "registered",
  route: "route",
  savings: "savings",
  withdrawal: "withdrawal",
  link: "link",
  migration: "migration",
  balance: "balance",
  pieces: "pieces",
  synced: "synced",
  uses: "uses",
}

/** A1's Add, once the entry checks answered: what it opened, and what holds the add. */
export function reportAddTapped(add: BackupAddState): void {
  switch (add.kind) {
    case "none":
    case "checking":
      return
    case "unreadable":
      return fireEvent("backup_add_tapped", { entry: "unreadable" })
    case "ready":
      return fireEvent("backup_add_tapped", { entry: "ready", links: upTo(add.links, 2) })
    case "blocked": {
      const screen = add.screen === "blocked" ? blockedScreen(add.blocks).id : add.screen
      return fireEvent("backup_add_tapped", {
        entry: HELD[screen],
        block: BLOCKS[add.block.id],
        blocks: upTo(add.blocks.filter((block) => !block.done).length, 3),
      })
    }
  }
}

function etaBucket(seconds: number): string {
  if (seconds < 5 * 60) return "<5m"
  if (seconds < 15 * 60) return "<15m"
  if (seconds < 30 * 60) return "<30m"
  return ">=30m"
}

/** A2's Continue or Back. */
export function reportIntroAnswered(
  action: "continue" | "back",
  screen: { picker: boolean; eta?: number },
): void {
  fireEvent("backup_intro_answered", {
    action,
    picker: screen.picker,
    ...(screen.eta !== undefined && { eta: etaBucket(screen.eta) }),
  })
}

/** A3's Add: the place picked, the one the picker opened on, and how many it offered. */
export function reportPlaceChosen(place: {
  choice: BackupAddChoice
  opened: BackupAddChoice
  options: number
  windows10Warning: boolean
}): void {
  fireEvent("backup_place_chosen", {
    choice: place.choice,
    default: place.opened,
    options: place.options,
    windows10_warning: place.windows10Warning,
  })
}

/** The Pay tap: the speed, whether Faster could be had, the fee's range and the prompts ahead. */
export function reportPaySubmitted(pay: {
  speed: WithdrawalSpeed
  faster: "offered" | "blocked" | "none"
  /** In cents. */
  fee: bigint
  approvals: number
}): void {
  fireEvent("backup_pay_submitted", {
    speed: pay.speed,
    faster: pay.faster,
    amount_bucket: amountBucket(pay.fee, 2),
    approvals: approvalsBucket(pay.approvals),
  })
}

/** A step the user tapped failed. */
export function reportStepFailed(failure: BackupFailure, record?: BackupRotationRecord): void {
  fireEvent("backup_step_failed", {
    step: failure.step,
    kind: failure.kind,
    charged: failure.charged,
    leftover: failure.leftover,
    phase: record?.phase ?? "none",
  })
}

export function reportCancelled(record: BackupRotationRecord, from: CancelFrom): void {
  fireEvent("backup_cancelled", { phase: record.phase, from, charged: charged(record) })
}

export function reportFailureAnswered(sheet: SheetKind, control: SheetMove): void {
  fireEvent("backup_failure_answered", { sheet, control })
}

export function reportLeavePrompted(
  kind: "leave" | "cancel",
  answer: "stay" | "confirm",
  phase: BackupRotationPhase | undefined,
): void {
  fireEvent("backup_leave_prompted", { kind, answer, phase: phase ?? "none" })
}

const ACTIONS: Record<EntryAction, string> = {
  deposit: "deposit",
  activity: "activity",
  savings: "savings",
  migration: "migration",
  signOut: "sign_out",
}

/** A blocked entry's way out: a row's link, the short balance's Deposit, or signing out. */
export function reportBlockAction(block: EntryCondition["id"], action: EntryAction): void {
  fireEvent("backup_block_action", { block: BLOCKS[block], action: ACTIONS[action] })
}

/** The recovery the user asked for found the deposit address empty. */
export function reportRecoveryEmpty(record: BackupRotationRecord): void {
  fireEvent("backup_recovery", { state: "empty", extra: record.suspended === "done" })
}

// ── The saved attempt ──

export interface BackupFunnelEvent {
  event: Extract<AnalyticsEvent, `backup_${string}`>
  props: AnalyticsProps
}

/** The path's phases, in order; `installed` is the change run without this wallet's funding. */
const PATH = [
  "signed",
  "published",
  "funded",
  "swept",
  "installed",
  "rerooted",
  "moved",
  "done",
] as const satisfies readonly BackupRotationPhase[]

/** The path when this wallet's funding runs the change. */
const FUNDED_PATH: readonly BackupRotationPhase[] = PATH.filter((step) => step !== "installed")

/**
 * The path's phases a record at `phase` reached, in order, then `phase` when it is a side state:
 * each one `phase` comes after or the record's saved facts show, whichever writes a page saw.
 */
function pathTo(record: BackupRotationRecord, phase: BackupRotationPhase): BackupRotationPhase[] {
  const at = FUNDED_PATH.indexOf(phase)
  const past = (step: BackupRotationPhase) => at >= FUNDED_PATH.indexOf(step)
  const installed = phase === "installed" || record.installed !== undefined
  const reached: Record<(typeof PATH)[number], boolean> = {
    signed: true,
    published: past("published") || installed || record.publish !== undefined,
    funded:
      (past("funded") && !installed) ||
      record.fundings.some((funding) => funding.txHash !== undefined),
    swept: (past("swept") && !installed) || record.sweep !== undefined,
    installed,
    rerooted: past("rerooted"),
    moved: past("moved"),
    done: past("done"),
  }
  const path: BackupRotationPhase[] = PATH.filter((step) => reached[step])
  return phase === "conflict" || phase === "recovered" ? [...path, phase] : path
}

/** The steps a record reached, in order: a phase or `attention:<why>`; none at `created`. */
function stepsOf(record: BackupRotationRecord): string[] {
  if (record.phase === "created") return []
  if (record.phase !== "attention") return pathTo(record, record.phase)
  const before =
    record.suspended && record.suspended !== "created" ? pathTo(record, record.suspended) : []
  return [...before, `attention:${record.attention ?? "corrupt"}`]
}

const NO_MARK = (attemptId: string): BackupFunnelMark => ({ attemptId, reported: [] })

/**
 * The events `records` owe against their marks. A step reached while no page watched is reported
 * with the ones before it; only the step the record stands at carries times, and the time since the
 * step before it only when that step was reported while the record stood at it.
 */
export function backupTransitions(
  records: readonly BackupRotationRecord[],
  marks: BackupFunnelMarks,
): { next: BackupFunnelMarks; events: BackupFunnelEvent[] } {
  const next: Record<string, BackupFunnelMark> = { ...marks }
  const events: BackupFunnelEvent[] = []
  for (const record of records) {
    const mark = marks[record.attemptId] ?? NO_MARK(record.attemptId)
    const reported = new Set(mark.reported)
    const steps = stepsOf(record)
    const owed = steps.filter((step) => !reported.has(step))
    const last = steps.at(-1)
    for (const step of owed) {
      const [phase, attention] = step.split(":")
      const index = steps.indexOf(step)
      const before = index === 0 ? "created" : steps[index - 1]
      const since =
        before === "created"
          ? record.createdAt
          : mark.timed?.step === before
          ? mark.timed.at
          : undefined
      events.push({
        event: "backup_rotation_phase",
        props: {
          phase,
          ...(attention && { attention }),
          ...(step === last && { since_start_ms: lap(record.updatedAt - record.createdAt) }),
          ...(step === last &&
            since !== undefined && { prev_phase_ms: lap(record.updatedAt - since) }),
        },
      })
    }
    const recovery = recoveryState(record)
    const recoveryStep = recovery && `recovery:${recovery}`
    const recovering = recoveryStep !== undefined && !reported.has(recoveryStep)
    if (recovering)
      events.push({
        event: "backup_recovery",
        props: { state: recovery, extra: record.suspended === "done" },
      })
    if (owed.length === 0 && !recovering) continue
    // An attention pauses the path, so the step after it is timed from the phase before it.
    const timed =
      last && owed.includes(last) && !last.startsWith("attention:")
        ? { step: last, at: record.updatedAt }
        : mark.timed
    next[record.attemptId] = {
      attemptId: record.attemptId,
      reported: [...mark.reported, ...owed, ...(recovering ? [recoveryStep] : [])],
      ...(timed && { timed }),
    }
  }
  return { next, events }
}

/** Saves what `records` owe against their marks, and sends it once saved. */
export async function reportBackupFunnel(
  records: readonly BackupRotationRecord[],
  funnel: BackupFunnel,
): Promise<void> {
  const events = await bestEffort(
    "unknown",
    funnel.report(
      records.map((record) => record.attemptId),
      (marks) => backupTransitions(records, marks),
    ),
  )
  for (const { event, props } of events ?? []) fireEvent(event, props)
}

/** The sheet says the attempt is delayed: once per attempt per delay. */
export async function reportDelayed(
  funnel: BackupFunnel,
  record: BackupRotationRecord,
  delay: BackupDelay,
): Promise<void> {
  const step = `delay:${delay}`
  const owed = await bestEffort(
    "unknown",
    funnel.report([record.attemptId], (marks) => {
      const mark = marks[record.attemptId] ?? NO_MARK(record.attemptId)
      if (mark.reported.includes(step)) return { next: marks, events: [] }
      return {
        next: { ...marks, [record.attemptId]: { ...mark, reported: [...mark.reported, step] } },
        events: [step],
      }
    }),
  )
  if (owed?.length) fireEvent("backup_delayed", { delay, phase: record.phase })
}

// ── Account history ──

/** A check of the earlier address ended: what it found, as the sheet shows it. */
export function reportHistoryChecked(history: AccountHistory): void {
  if (history.kind !== "rotation") return
  const { status } = history
  switch (status.kind) {
    case "empty":
    case "unclaimed":
    case "incomplete":
      return fireEvent("account_history_checked", { result: status.kind })
    case "found": {
      const kinds = new Set(status.held.map((holding) => holding.kind))
      return fireEvent("account_history_checked", {
        result: "found",
        holdings: kinds.size > 1 ? "both" : [...kinds][0],
      })
    }
  }
}

/**
 * A move of the earlier address's funds ended: everything moved, some of it, or nothing and why.
 * `approvals` is what the move was planned to ask for.
 */
export function reportMoveEnded(
  outcome: PreviousMoveOutcome,
  history: AccountHistory,
  approvals: number | undefined,
): void {
  const status = history.kind === "rotation" ? history.status : undefined
  const found = status?.kind === "found" ? status : undefined
  const movedSome = found?.rows?.some((row) => row.state === "moved" || row.state === "partial")
  const ended =
    outcome.kind === "done"
      ? "moved"
      : movedSome
      ? "partial"
      : outcome.kind === "stopped"
      ? "declined"
      : outcome.kind === "failed"
      ? "failed"
      : found?.note === "stuck"
      ? "stuck"
      : "refused"
  fireEvent("account_history_move_ended", {
    outcome: ended,
    ...(approvals !== undefined && { approvals: approvalsBucket(approvals) }),
  })
}
