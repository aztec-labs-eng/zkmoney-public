import { isDust, type BackupRotationRecord } from "@obsidion/front-core"
import type { SavedRotations } from "./backupRotations"
import type { PreviousAccountState, PreviousHolding } from "./previousAccountWatcher"

const MAX_REFUSALS = 3

/** Why found funds can't move from here, or how the last move ended. */
export type FoundNote =
  | "resume"
  | "rotationsUnread"
  | "backupSession"
  | "refused"
  | "stuck"
  | "failed"

/** Where the check of the earlier address stands. */
export type CheckStatus =
  | { kind: "unchecked" }
  | { kind: "checking" }
  | { kind: "incomplete" }
  | { kind: "unclaimed" }
  | { kind: "empty" }
  | {
      kind: "found"
      held: readonly PreviousHolding[]
      note?: FoundNote
      action?: "move" | "retry"
    }
  | { kind: "moving" }

/** Settings → Account history: no event, or the backup passkey's with its earlier address. */
export type AccountHistory =
  | { kind: "none" }
  | { kind: "rotation"; earlier: string; status: CheckStatus }

/** A rotation that no longer moves its one-key account's balance. */
const finished = (record: BackupRotationRecord) =>
  record.phase === "done" ||
  record.phase === "conflict" ||
  record.phase === "recovered" ||
  (record.phase === "attention" &&
    (record.suspended === "done" || record.suspended === "recovered"))

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

function checkStatus(
  state: PreviousAccountState,
  earlier: string,
  rotations: SavedRotations,
): CheckStatus {
  if (state.moving) return { kind: "moving" }
  if (state.checking) return { kind: "checking" }
  const held = (state.holdings ?? []).filter(worthMoving)
  if (held.length === 0) {
    if (state.checkFailed) return { kind: "incomplete" }
    if (!state.holdings || !state.address) return { kind: "unchecked" }
    // A claims pass that fell short can't tell an empty address from one with deposits waiting.
    if (!state.claimsIncomplete) return { kind: "empty" }
    // Only the first passkey claims the account's deposits, so a backup session can't finish.
    return state.signs ? { kind: "incomplete" } : { kind: "unclaimed" }
  }
  const found = (note?: FoundNote, action?: "move" | "retry"): CheckStatus => ({
    kind: "found",
    held,
    ...(note && { note }),
    ...(action && { action }),
  })
  if (!state.signs) return found("backupSession")
  if (typeof rotations === "string") return found("rotationsUnread")
  const owns = (record: BackupRotationRecord) =>
    record.rotation?.builtOver.l2Address.toLowerCase() === earlier.toLowerCase()
  // Two movers would ask for two prompts: an unfinished rotation keeps moving this balance itself.
  if (rotations.some((record) => owns(record) && !finished(record))) return found("resume")
  if (state.refusals >= MAX_REFUSALS || (state.cap !== undefined && state.cap < 1n)) {
    return found("stuck")
  }
  const last = state.lastResult
  if (last?.kind === "refused" && last.reason === "spend") return found("refused", "retry")
  if (last?.kind === "refused" || last?.kind === "failed") return found("failed", "retry")
  return found(undefined, "move")
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
