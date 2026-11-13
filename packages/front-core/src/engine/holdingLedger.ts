import type { WithdrawalRecord } from "../core/services/bridge/types"
import type { MoveDeposit, MoveQuote, MoveRecord } from "./moveTransition"

/** The fields of a move record the ledger reads. */
export type LedgerMove = Pick<
  MoveRecord,
  | "id"
  | "holdingId"
  | "direction"
  | "amount"
  | "phase"
  | "assets"
  | "withdrawalLocalId"
  | "startTime"
> & {
  quote?: Pick<MoveQuote, "conversionOut">
  deposit?: Pick<MoveDeposit, "amount" | "at">
}

export type LedgerBurn = Pick<WithdrawalRecord, "phase" | "l2TxHash" | "minedAt" | "startTime">

/**
 * A counted move the ledger cannot price. `noCost`: a move in with neither the vault's figure nor a
 * quote, which nothing reads again. `burnUnmined`: a move out whose burn was sent and is not yet
 * seen mined.
 */
export interface LedgerExclusion {
  moveId: string
  reason: "noCost" | "burnUnmined"
}

export interface HoldingLedger {
  /**
   * What the shares the replay leaves cost, in the asset: what went in, less each move out's part.
   */
  basis: bigint
  /** Moves that count: claimed in, or out with its burn mined or sent. */
  counted: number
  /** Shares the replay leaves, to compare with the shares held. */
  shares: bigint
  excluded: LedgerExclusion[]
}

/** The burn's phases before its shares have left the holding. */
const UNMINED: ReadonlySet<WithdrawalRecord["phase"]> = new Set(["submitting", "failed"])

/**
 * The cost of the shares `moves` leave, at average cost, replayed in the order the shares moved: a
 * move in when its deposit landed, a move out when its burn was mined. A claimed move in adds its
 * shares and the asset it put in: the vault's own figure, else its quote's. A mined move out takes
 * its shares and their part of the cost. A replayed move out has no burn record: replay finds only
 * mined burns. A dropped move never burned. `burns` holds the moves' burn records by local id.
 */
export function holdingLedger(
  moves: readonly LedgerMove[],
  burns: ReadonlyMap<string, LedgerBurn>,
): HoldingLedger {
  const ledger: HoldingLedger = { basis: 0n, counted: 0, shares: 0n, excluded: [] }
  const burnOf = (move: LedgerMove) =>
    move.withdrawalLocalId === undefined ? undefined : burns.get(move.withdrawalLocalId)
  const movedAt = (move: LedgerMove) => {
    if (move.direction === "in") return move.deposit?.at ?? move.startTime
    const burn = burnOf(move)
    return burn?.minedAt ?? burn?.startTime ?? move.startTime
  }
  const counted = moves.filter((move) => move.phase !== "dropped")
  for (const move of counted.sort((a, b) => movedAt(a) - movedAt(b))) {
    if (move.direction === "in") {
      if (move.phase !== "claimed" || !move.deposit) continue
      ledger.counted += 1
      ledger.shares += move.deposit.amount
      const cost = move.assets ?? move.quote?.conversionOut
      if (cost !== undefined) ledger.basis += cost
      else ledger.excluded.push({ moveId: move.id, reason: "noCost" })
      continue
    }
    const burn = burnOf(move)
    if (burn && UNMINED.has(burn.phase)) {
      // Sent: its shares may already have left, so the figure waits for it.
      if (burn.phase === "submitting" && burn.l2TxHash) {
        ledger.counted += 1
        ledger.excluded.push({ moveId: move.id, reason: "burnUnmined" })
      }
      continue
    }
    ledger.counted += 1
    const before = ledger.shares
    const out = move.amount < before ? move.amount : before
    ledger.basis -= before > 0n ? (ledger.basis * out) / before : ledger.basis
    ledger.shares = before - out
  }
  return ledger
}

/**
 * How far the replay may differ from the shares held and still describe them: a millionth of a
 * share.
 */
export const shareDust = (shareDecimals: number): bigint =>
  10n ** BigInt(Math.max(shareDecimals - 6, 0))

/**
 * What the shares held have earned: `value` less what they cost, nothing once none are held.
 * Unknown while a counted move is excluded, or while the replay does not account for the shares
 * held (a fresh device before its moves are replayed), since the balance would read as earnings.
 */
export function holdingEarned(
  ledger: HoldingLedger,
  value: bigint,
  sharesHeld: bigint,
  shareDecimals: number,
): bigint | undefined {
  if (ledger.excluded.length > 0) return undefined
  if (sharesHeld === 0n) return 0n
  const off = ledger.shares > sharesHeld ? ledger.shares - sharesHeld : sharesHeld - ledger.shares
  if (off > shareDust(shareDecimals)) return undefined
  return value - (ledger.basis > 0n ? ledger.basis : 0n)
}

/** Earned is unknown only until the burns it waits on are seen mined. */
export const holdingEarnedPending = (ledger: HoldingLedger): boolean =>
  ledger.excluded.length > 0 && ledger.excluded.every((e) => e.reason === "burnUnmined")
