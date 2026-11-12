import { isDust, type BackupRotationRecord } from "@obsidion/front-core"
import type { SavedRotations } from "./backupRotations"
import type {
  MoveForecast,
  MoveRun,
  PreviousAccountState,
  PreviousHolding,
} from "./previousAccountWatcher"

const MAX_REFUSALS = 3

/** Why found funds can't move from here, or how the last move ended. */
export type FoundNote = "backupSession" | "refused" | "stuck" | "failed"

/**
 * A balance of a move as the sheet lists it. While the move runs, the balance it is on is
 * `preparing` a transfer, `confirming` one that is out, or `working` between two. At rest a
 * balance is `moved`, `partial` or untouched (`none`).
 */
export interface MoveRowView {
  kind: PreviousHolding["kind"]
  state: "moved" | "partial" | "none" | "working" | "preparing" | "confirming"
}

/** The approvals a running move still asks for, the one being prepared included. */
export interface ApprovalsLeft {
  count: number
  upper: boolean
}

/** Where the check of the earlier address stands. */
export type CheckStatus =
  | { kind: "settingUp" }
  | { kind: "setupUnread" }
  | { kind: "unchecked" }
  | { kind: "checking" }
  | { kind: "incomplete" }
  | { kind: "unclaimed" }
  | { kind: "empty" }
  | {
      kind: "found"
      held: readonly PreviousHolding[]
      note?: FoundNote
      /** `continue` resumes a move that stopped after moving something. */
      action?: "move" | "retry" | "continue"
      /** The approvals moving `held` takes, where it could be planned. */
      forecast?: MoveForecast
      /** How far the last move got, when it ended early. */
      rows?: readonly MoveRowView[]
    }
  | {
      kind: "moving"
      rows: readonly MoveRowView[]
      left?: ApprovalsLeft
      /** A transfer an earlier visit left in flight is being finished first. */
      earlier?: true
    }
  /** The move this sheet ran left nothing behind. */
  | { kind: "moved" }

/** Settings → Account history: no event, or the backup passkey's with its earlier address. */
export type AccountHistory =
  | { kind: "none" }
  | { kind: "rotation"; earlier: string; status: CheckStatus }

/** A rotation that no longer moves its one-key account's balance; a damaged one never moves on. */
const finished = (record: BackupRotationRecord) =>
  record.phase === "done" ||
  record.phase === "conflict" ||
  record.phase === "recovered" ||
  (record.phase === "attention" &&
    (record.attention === "corrupt" ||
      record.suspended === "done" ||
      record.suspended === "recovered"))

const owns = (record: BackupRotationRecord, earlier: string) =>
  record.rotation?.builtOver.l2Address.toLowerCase() === earlier.toLowerCase()

const worthMoving = (holding: PreviousHolding) => !isDust(holding.amount, holding.dust)

/** `saved` is the earlier address an earlier session found, known before this one finds it. */
export function selectAccountHistory(
  state: PreviousAccountState,
  saved: string | undefined,
  rotations: SavedRotations,
): AccountHistory {
  const earlier = state.address ?? saved
  if (!earlier) return { kind: "none" }
  return { kind: "rotation", earlier, status: checkStatus(state, earlier, rotations) }
}

function rowsOf(run: MoveRun, moving: boolean): MoveRowView[] {
  // A transfer from an earlier visit belongs to no balance: none works while it is finished.
  let active = moving && !run.earlier
  return run.rows.map(({ kind, done, moved, phase }): MoveRowView => {
    if (done) return { kind, state: "moved" }
    if (active) {
      active = false
      return { kind, state: phase ?? "working" }
    }
    return { kind, state: moved > 0 ? "partial" : "none" }
  })
}

/** None once the run has asked for as many as were planned, or where no plan was read. */
function approvalsLeftOf({ forecast, run }: PreviousAccountState): ApprovalsLeft | undefined {
  if (!forecast || !run) return undefined
  const preparing = run.rows.some(({ phase }) => phase === "preparing") ? 1 : 0
  const count = forecast.approvals - run.approvals + preparing
  return count > 0 ? { count, upper: forecast.upper } : undefined
}

const movedSome = (run: MoveRun) => run.rows.some(({ done, moved }) => done || moved > 0)

function checkStatus(
  state: PreviousAccountState,
  earlier: string,
  rotations: SavedRotations,
): CheckStatus {
  if (state.moving) {
    const left = approvalsLeftOf(state)
    return {
      kind: "moving",
      rows: state.run ? rowsOf(state.run, true) : [],
      ...(left && { left }),
      ...(state.run?.earlier && { earlier: true }),
    }
  }
  if (state.checking) return { kind: "checking" }
  if (typeof rotations === "string") return { kind: "setupUnread" }
  // An unfinished rotation still moves this balance itself: a check would list it as found, and a
  // second mover would ask for a second prompt.
  if (rotations.some((record) => owns(record, earlier) && !finished(record))) {
    return { kind: "settingUp" }
  }
  const held = (state.holdings ?? []).filter(worthMoving)
  if (held.length === 0) {
    if (state.checkFailed) return { kind: "incomplete" }
    // A move that left nothing says so, unless deposits may still wait unclaimed.
    if (state.moved && !state.claimsIncomplete) return { kind: "moved" }
    if (!state.holdings || !state.address) return { kind: "unchecked" }
    // A claims pass that fell short can't tell an empty address from one with deposits waiting.
    if (!state.claimsIncomplete) return { kind: "empty" }
    // Only the first passkey claims the account's deposits, so a backup session can't finish.
    return state.signs ? { kind: "incomplete" } : { kind: "unclaimed" }
  }
  const found = (note?: FoundNote, action?: "move" | "retry" | "continue"): CheckStatus => ({
    kind: "found",
    held,
    ...(note && { note }),
    ...(action && { action }),
    ...(state.forecast && { forecast: state.forecast }),
    ...(state.run && { rows: rowsOf(state.run, false) }),
  })
  if (!state.signs) return found("backupSession")
  if (state.refusals >= MAX_REFUSALS || (state.cap !== undefined && state.cap < 1n)) {
    return found("stuck")
  }
  const last = state.lastResult
  if (last?.kind === "refused" && last.reason === "spend") return found("refused", "retry")
  if (last?.kind === "refused" || last?.kind === "failed") return found("failed", "retry")
  return found(undefined, state.run && movedSome(state.run) ? "continue" : "move")
}

/** Whether a move stopped early with funds left that this session can go on moving. */
export function selectMoveUnfinished(history: AccountHistory): boolean {
  if (history.kind !== "rotation" || history.status.kind !== "found") return false
  return history.status.rows !== undefined && history.status.action !== undefined
}

/** What the Settings row shows: no event, one, or one whose check found funds. */
export function selectHistoryRow(history: AccountHistory): "none" | "one" | "found" {
  if (history.kind === "none") return "none"
  return history.status.kind === "found" ? "found" : "one"
}

/** What the found funds are worth in Main's unit; undefined while Savings' shares have no price. */
export function selectHeldTotal(held: readonly PreviousHolding[]): bigint | undefined {
  let total = 0n
  for (const holding of held) {
    const value = holding.kind === "main" ? holding.amount : holding.value
    if (value === undefined) return undefined
    total += value
  }
  return total
}
