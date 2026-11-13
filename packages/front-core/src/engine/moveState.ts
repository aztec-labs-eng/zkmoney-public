import type { WithdrawalRecord } from "../core/services/bridge/types"
import type { Failure } from "./errors"
import type { MoveRecord } from "./moveTransition"

/** The relayer retries a reverting release this long by default, then drops it. */
export const RELAYER_MAX_PENDING_AGE_MS = 14 * 24 * 60 * 60 * 1000

/**
 * What a delayed move waits on. `illiquidVault`: the vault cannot redeem the shares until its
 * markets have liquidity. `vaultFull`: the vault takes no more deposits. `relayerDropped`: no known
 * condition, and the relayer dropped the release after its max pending age.
 */
export type MoveDelay = "illiquidVault" | "vaultFull" | "relayerDropped"

/** Where a move stands. A move that waits on an L1 condition is delayed, never failed. */
export type MoveState =
  | { kind: "proving" }
  | { kind: "submitting" }
  | { kind: "pending" }
  /** `dropped`: the relayer gave up on the release, which runs again only when broadcast again. */
  | { kind: "delayed"; reason: MoveDelay; dropped: boolean }
  | { kind: "done" }
  | { kind: "failed"; failure?: Failure }
  | { kind: "recovered" }
  | { kind: "dropped" }

const PENDING: MoveState = { kind: "pending" }

/**
 * `withdrawal` is the burn's record, once the withdrawals store loaded it. A replayed move has
 * none: its burn was made on another device, and its wait counts from its start time.
 */
export function selectMoveState(
  move: Pick<
    MoveRecord,
    | "phase"
    | "rail"
    | "direction"
    | "amount"
    | "quote"
    | "observed"
    | "failure"
    | "startTime"
    | "replayedFrom"
  >,
  withdrawal:
    | Pick<WithdrawalRecord, "phase" | "l2TxHash" | "minedAt" | "startTime" | "failure">
    | undefined,
  now: number,
): MoveState {
  // A migrated move's funds follow the upgrade, which shows on its own.
  if (move.phase === "claimed" || move.phase === "migrated") return { kind: "done" }
  if (move.phase === "failed") return { kind: "failed", failure: move.failure }
  if (move.phase === "recovered") return { kind: "recovered" }
  if (move.phase === "dropped") return { kind: "dropped" }
  // Released: the deposit's claim follows.
  if (move.phase !== "burning" && move.phase !== "burned") return PENDING
  if (!withdrawal) {
    if (move.phase === "burning") return { kind: "proving" }
    // Not replayed: the burn's record is still loading.
    if (move.replayedFrom === undefined) return PENDING
    return waiting(move, move.startTime, now)
  }
  if (withdrawal.phase === "failed") return { kind: "failed", failure: withdrawal.failure }
  if (withdrawal.phase === "submitting") {
    return withdrawal.l2TxHash ? { kind: "submitting" } : { kind: "proving" }
  }
  // A spent escrow burn still waits, on whoever runs the escrow.
  const spent = withdrawal.phase === "done" && move.rail === "skyEscrow"
  if (withdrawal.phase !== "finalizing_l1" && !spent) return PENDING
  return waiting(move, withdrawal.minedAt ?? withdrawal.startTime, now)
}

/**
 * A move whose release waits on L1 since `since`, held to the terms' limits in their own units:
 * a move in by what its conversion delivers in the vault's asset, a move out by the shares it
 * redeems. A replayed move keeps no quote: moving out its burn's shares bound it, moving in nothing
 * does.
 */
function waiting(
  move: Pick<MoveRecord, "direction" | "amount" | "quote" | "observed">,
  since: number,
  now: number,
): MoveState {
  const dropped = now - since >= RELAYER_MAX_PENDING_AGE_MS
  const limits = move.observed
  const redeemed = move.quote?.routed ?? move.amount
  const deposited = move.quote?.conversionOut
  const reason: MoveDelay | undefined =
    limits && move.direction === "out" && limits.maxRedeem < redeemed
      ? "illiquidVault"
      : limits &&
        move.direction === "in" &&
        deposited !== undefined &&
        limits.maxDeposit < deposited
      ? "vaultFull"
      : dropped
      ? "relayerDropped"
      : undefined
  return reason ? { kind: "delayed", reason, dropped } : PENDING
}
