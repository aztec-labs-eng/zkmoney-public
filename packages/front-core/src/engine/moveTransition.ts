import type { Address, Hash, Hex } from "viem"
import type { Failure } from "./errors"

export type MoveDirection = "in" | "out"

/**
 * `burning`: the burn's withdrawal record exists and its burn is not yet mined. `burned`: mined.
 * `released`: the release ran the route. `depositSeen`: the route's portal deposit is on L1.
 * `recovered`: the funds went back to an L1 address before the route ran. `migrated`: a retired
 * rollup's move that never settled there; an old version's refund of its deposit recovers it.
 * `dropped`: its burn never went out. `claimed`, `failed`, `recovered` and `dropped` are terminal.
 */
export type MovePhase =
  | "burning"
  | "burned"
  | "released"
  | "depositSeen"
  | "claimed"
  | "failed"
  | "recovered"
  | "migrated"
  | "dropped"

/** What a move was priced at when built, in base units. */
export interface MoveQuote {
  /** What the route keeps: the burn less both tips and the bridge fee. */
  routed: bigint
  relayerTip: bigint
  /** What the conversion returns, and the floor the route holds it to. */
  conversionOut: bigint
  conversionMinOut: bigint
  /** What the terms step returns at the quoted rate, and the floor the route holds it to. */
  expectedOut: bigint
  minOut: bigint
  /** The burn's withdrawal executor's fee, in the base token: part of the burn, as the tips are. */
  withdrawalFee: bigint
  /** Who receives `withdrawalFee`, where the executor names one. */
  feeBeneficiary?: Address
}

/** What the holding's terms take now: a deposit in the asset, a redeem in the held token. */
export interface MoveLimits {
  maxDeposit: bigint
  maxRedeem: bigint
}

/** The escrow a Sky escrow move's burn pays, and the tip it pays whoever runs it. */
export interface MoveEscrow {
  factory: Address
  address: Address
  tip: bigint
}

/** The route's deposit into the destination portal: what the claim needs. */
export interface MoveDeposit {
  inboxIndex: bigint
  amount: bigint
  /** Absent on a move carried from a retired rollup, whose old record never kept it. */
  messageKey?: Hex
  /** When the deposit's L1 block was made, ms: when the move's shares entered or left. */
  at: number
}

/** A vault move's rail fields: the portal its route deposits into, which names the holding. */
export interface MoveExecutorFields {
  rail: "executor"
  destination: Address
}

export type MoveRailFields = MoveExecutorFields | { rail: "skyEscrow"; escrow: MoveEscrow }

/** The L1 target a move's burn pays: the multi-step executor, or a Sky escrow. */
export type MoveRail = MoveRailFields["rail"]

interface MoveFields {
  id: string
  holdingId: string
  direction: MoveDirection
  /** What left the source: the base's token moving in, the holding's moving out. */
  amount: bigint
  /** Absent on a replayed move. */
  quote?: MoveQuote
  /** The burn's withdrawal record; absent on a replayed move. */
  withdrawalLocalId?: string
  /** The burn's withdrawal on L1; a replayed move's release is read by it. */
  withdrawalId?: Hex
  /** With the master secret, derives the deposit's claim secret and the recovery salt. */
  nonce: Hex
  /** What the route's portal deposit commits to. */
  recipientCommitment: Hex
  /** The L1 block the deposit is searched from. */
  scanFrom: bigint
  /** The last L1 block searched for the deposit without finding it. */
  scannedTo?: bigint
  phase: MovePhase
  startTime: number
  endTime?: number
  /** When the burn's release paid the route's L1 target, read off L1 for a replayed move. */
  releasedAt?: number
  /** The terms' limits, read while the release waits. */
  observed?: { at: number } & MoveLimits
  l1?: { releaseTx?: Hash; depositTx?: Hash; recoveryTx?: Hash }
  deposit?: MoveDeposit
  /** What the vault took in moving in, or paid out moving out, in its asset, as the run reports. */
  assets?: bigint
  /** Where a recovered move's funds went. */
  recoveredTo?: Address
  failure?: Failure
  /** The burn's L2 tx, on a move rebuilt from the burn's recovery data. */
  replayedFrom?: string
}

/** One move: a burn to its rail's L1 target, then a deposit the account claims. */
export type MoveRecord = MoveRailFields & MoveFields

/** What a move is built with, before its burn is sent. */
export type BuiltMove = MoveRailFields &
  Pick<
    MoveFields,
    | "id"
    | "holdingId"
    | "direction"
    | "amount"
    | "nonce"
    | "recipientCommitment"
    | "scanFrom"
    | "startTime"
  > & { quote: MoveQuote; withdrawalLocalId: string }

/** The phases a replay finds a move in. */
export type ReplayedPhase = Extract<MovePhase, "burned" | "released" | "depositSeen" | "recovered">

/** A move rebuilt from its burn on chain, in the phase the chain shows. */
export type ReplayedMove = MoveRailFields &
  Omit<
    MoveFields,
    | "phase"
    | "quote"
    | "withdrawalLocalId"
    | "withdrawalId"
    | "observed"
    | "failure"
    | "replayedFrom"
  > & { phase: ReplayedPhase; withdrawalId: Hex; replayedFrom: string }

export type MoveEvent =
  | { type: "built"; record: BuiltMove }
  | { type: "replayed"; record: ReplayedMove }
  /** A record from a retired rollup's database, carried into this rollup's store. */
  | { type: "migrated"; record: MoveRecord; at: number }
  | { type: "burnMined" }
  | { type: "released"; txHash?: Hash; assets?: bigint }
  /** The burn's release, read off L1 before the route runs. */
  | { type: "releaseSeen"; txHash: Hash; at: number }
  /** The deposit search reached `to` without finding it. */
  | { type: "scanned"; to: bigint }
  | { type: "depositSeen"; txHash: Hash; deposit: MoveDeposit }
  | { type: "claimed"; at: number }
  | { type: "observed"; limits: MoveLimits; at: number }
  | { type: "failed"; failure: Failure; at: number }
  /** The funds went back to `to` on L1 before the route ran. */
  | { type: "recovered"; txHash: Hash; to: Address; at: number }
  /** The burn never went out: its withdrawal record was dropped before the node took it. */
  | { type: "dropped"; at: number }

const TERMINAL: ReadonlySet<MovePhase> = new Set(["claimed", "failed", "recovered", "dropped"])
const BEFORE_RELEASE: ReadonlySet<MovePhase> = new Set(["burning", "burned"])

/** Nothing on this rollup moves it on: terminal, or a retired rollup's, that only a refund ends. */
export const isMoveSettled = (record: Pick<MoveRecord, "phase">) =>
  TERMINAL.has(record.phase) || record.phase === "migrated"

/** A quote's figures, without what else the read that made it returned. */
const quoteFigures = (quote: MoveQuote): MoveQuote => ({
  routed: quote.routed,
  relayerTip: quote.relayerTip,
  conversionOut: quote.conversionOut,
  conversionMinOut: quote.conversionMinOut,
  expectedOut: quote.expectedOut,
  minOut: quote.minOut,
  withdrawalFee: quote.withdrawalFee,
})

/**
 * The one place a move record changes; `undefined` leaves it as it is. `built`, `replayed` and
 * `migrated` alone create one, and never over one. A migrated record keeps a terminal phase and
 * takes `migrated` over any other, since nothing on this rollup can finish it; it then takes only
 * `recovered`. Terminal phases take nothing. Only a move not yet released can fail or be recovered:
 * after the release its funds sit in the destination portal, and only their claim remains. Limits
 * apply in the order they were read. Only a move still burning can be dropped. The search cursor
 * only moves forward, and stops once the deposit is seen. A release is seen once, before the route
 * runs.
 */
export function moveTransition(
  record: MoveRecord | undefined,
  event: MoveEvent,
): MoveRecord | undefined {
  if (event.type === "built") {
    if (record) return undefined
    return { ...event.record, quote: quoteFigures(event.record.quote), phase: "burning" }
  }
  if (event.type === "replayed") return record ? undefined : event.record
  if (event.type === "migrated") {
    if (record) return undefined
    const { quote, ...rest } = event.record
    const moved: MoveRecord = { ...rest, ...(quote ? { quote: quoteFigures(quote) } : {}) }
    return TERMINAL.has(moved.phase) ? moved : { ...moved, phase: "migrated", endTime: event.at }
  }
  if (!record || TERMINAL.has(record.phase)) return undefined
  if (record.phase === "migrated" && event.type !== "recovered") return undefined
  switch (event.type) {
    case "burnMined":
      return record.phase === "burning" ? { ...record, phase: "burned" } : undefined
    case "released":
      if (!BEFORE_RELEASE.has(record.phase)) return undefined
      return {
        ...record,
        phase: "released",
        ...(event.txHash ? { l1: { ...record.l1, releaseTx: event.txHash } } : {}),
        ...(event.assets === undefined ? {} : { assets: event.assets }),
      }
    case "releaseSeen":
      if (!BEFORE_RELEASE.has(record.phase) || record.releasedAt !== undefined) return undefined
      return { ...record, releasedAt: event.at, l1: { ...record.l1, releaseTx: event.txHash } }
    case "scanned":
      if (record.phase === "depositSeen") return undefined
      if (record.scannedTo !== undefined && event.to <= record.scannedTo) return undefined
      return { ...record, scannedTo: event.to }
    case "depositSeen":
      if (record.phase === "depositSeen") return undefined
      return {
        ...record,
        phase: "depositSeen",
        deposit: event.deposit,
        l1: {
          ...record.l1,
          // On the executor rail the release makes the deposit in the same transaction.
          ...(record.rail === "executor" && !record.l1?.releaseTx
            ? { releaseTx: event.txHash }
            : {}),
          depositTx: event.txHash,
        },
      }
    case "claimed":
      if (record.phase !== "depositSeen") return undefined
      return { ...record, phase: "claimed", endTime: event.at }
    case "observed":
      if (!BEFORE_RELEASE.has(record.phase)) return undefined
      if (record.observed && event.at <= record.observed.at) return undefined
      return {
        ...record,
        observed: {
          at: event.at,
          maxDeposit: event.limits.maxDeposit,
          maxRedeem: event.limits.maxRedeem,
        },
      }
    case "failed":
      if (!BEFORE_RELEASE.has(record.phase)) return undefined
      return { ...record, phase: "failed", failure: event.failure, endTime: event.at }
    case "recovered":
      if (!BEFORE_RELEASE.has(record.phase) && record.phase !== "migrated") return undefined
      return {
        ...record,
        phase: "recovered",
        recoveredTo: event.to,
        l1: { ...record.l1, recoveryTx: event.txHash },
        endTime: event.at,
      }
    case "dropped":
      if (record.phase !== "burning") return undefined
      return { ...record, phase: "dropped", endTime: event.at }
  }
}
