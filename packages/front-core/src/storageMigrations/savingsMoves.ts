/**
 * Storage migration: the Savings moves older builds kept under `acct/savingsMoves` and in a
 * `RecordStorage` blob before it. The moves store's first open converts the active database's into
 * move records; a retired rollup's database is read once, by the historic import. The old keys
 * stay, so a rollback still finds its moves. Remove when no supported build older than the one
 * that writes `acct/moves` v1 remains and the rollup migration reads no retired database.
 */
import { WalletError } from "@obsidion/core/errors"
import type { Address, Hex } from "viem"
import type { WithdrawalRecord } from "../core/services/bridge/types"
import type { Database } from "../engine/database"
import type { MovePhase, MoveQuote, MoveRecord } from "../engine/moveTransition"
import { decodeRecord } from "../engine/persistentStore"
import { logger } from "../utils/logger"

const SAVINGS_MOVES = "acct/savingsMoves"
const SAVINGS_MOVES_BLOB = "@obsidion/savings/moves"
const WITHDRAWALS = "acct/withdrawals"

/** The fields of an older build's Savings move the conversion reads. */
export interface SavedSavingsMove {
  direction: "in" | "out"
  /** The burn's withdrawal record, and the old store's key. */
  withdrawalLocalId: string
  escrow: Address
  nonce: Hex
  recipientCommitment: Hex
  amount: string
  /** The quote's DAI: what the burn was worth, and what the move lands. */
  value?: string
  net?: string
  depositScanFloor?: string
  depositScanFrom?: string
  deposit?: { inboxIndex: string; amount: string; claimed: boolean; at?: number; txHash?: Hex }
  /** The vault's own figures from the escrow run. */
  vault?: { assets: string }
  recovered?: { to: Address; txHashes: Hex[] }
  factory?: Address
  startTime: number
  endTime?: number
  /** Carried from a retired rollup's database, where the record ended. */
  retired?: true
}

/** The Sky holding converted moves count in: its id, and the factory its moves' escrows use. */
export interface SkyHoldingRef {
  id: string
  factory: Address
  /** The first L1 block either of the holding's portals existed at; 0 when one is unknown. */
  fromBlock: bigint
}

/** The burn fields a conversion reads. */
export type SavedBurn = Pick<
  WithdrawalRecord,
  | "phase"
  | "skyMove"
  | "withdrawalId"
  | "failure"
  | "l1TxHash"
  | "rawAmount"
  | "relayerTip"
  | "withdrawalFee"
  | "startTimeEstimated"
>

/** How far a device's clock may run ahead of L1's when it stamps a move's start. */
export const SAVED_START_MARGIN_MS = 60 * 60_000

/** The phases whose move still searches L1 for its run and its deposit. */
const SEARCHING: ReadonlySet<MovePhase> = new Set(["burning", "burned", "released"])

/**
 * Why a saved move was not converted. Each is logged. `damaged` does not read as a move;
 * `malformed` does, and holds a figure or field that does not.
 */
export type SkippedMove = "damaged" | "malformed" | "noSkyMeta" | "otherFactory"

const isSaved = (value: unknown): value is SavedSavingsMove => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.withdrawalLocalId === "string" &&
    (v.direction === "in" || v.direction === "out") &&
    typeof v.amount === "string" &&
    typeof v.startTime === "number" &&
    Number.isFinite(v.startTime)
  )
}

function parsed(raw: string, decode: (raw: string) => unknown): unknown {
  try {
    return decode(raw)
  } catch {
    return undefined // the decode boundary: a damaged move is skipped and counted
  }
}

/**
 * A database's Savings moves: the store's records, then the blob's it lacks. A move that does not
 * read is counted in `damaged` and skipped, so one damaged move never stops the rest.
 */
export function savedSavingsMoves(db: {
  get(key: string): string | null | undefined
  keys(prefix: string): string[]
}): { moves: SavedSavingsMove[]; damaged: number } {
  const out = new Map<string, SavedSavingsMove>()
  let damaged = 0
  const keep = (record: unknown) => {
    if (!isSaved(record)) damaged++
    else if (!out.has(record.withdrawalLocalId.toLowerCase()))
      out.set(record.withdrawalLocalId.toLowerCase(), record)
  }
  for (const key of db.keys(`${SAVINGS_MOVES}/`)) {
    const raw = db.get(key)
    if (typeof raw === "string") keep(parsed(raw, decodeRecord))
  }
  const blob = db.get(SAVINGS_MOVES_BLOB)
  const moves = typeof blob === "string" ? parsed(blob, JSON.parse) : undefined
  if (moves && typeof moves === "object" && !Array.isArray(moves))
    for (const move of Object.values(moves)) keep(move)
  else if (typeof blob === "string") damaged++
  return { moves: [...out.values()], damaged }
}

/** A retired database's Savings moves; a damaged one is logged and skipped. */
export function retiredSavingsMoves(db: {
  get(key: string): string | null | undefined
  keys(prefix: string): string[]
}): SavedSavingsMove[] {
  const { moves, damaged } = savedSavingsMoves(db)
  if (damaged) logger.warn(`[savingsMoves] a retired database holds ${damaged} damaged move(s)`)
  return moves
}

/** The phase the chain shows for a saved move, by the same facts the old store kept. */
function phaseOf(move: SavedSavingsMove, burn: SavedBurn | undefined): MovePhase {
  if (move.deposit?.claimed) return "claimed"
  if (move.recovered) return "recovered"
  if (burn?.phase === "failed") return "failed"
  if (move.retired) return "migrated"
  if (move.deposit) return "depositSeen"
  if (move.vault) return "released"
  // A burn released to an escrow nobody ran is still `burned`: the move's route has not run.
  return burn?.phase === "submitting" ? "burning" : "burned"
}

/**
 * The quote an older build's figures stand for, as the Sky rail quotes: moving out, the shares the
 * net is worth at the quote's rate are routed, and the rest tip. An older build kept no share figure
 * moving in, which no reader of a move in's quote needs.
 */
function quoteOf(move: SavedSavingsMove, burn: SavedBurn | undefined): MoveQuote | undefined {
  const floors = { conversionMinOut: 0n, minOut: 0n }
  const shares = move.deposit ? BigInt(move.deposit.amount) : 0n
  if (move.value === undefined || move.net === undefined) {
    // A move in rebuilt from its burn kept no quote: it put in the burn less its two tips. An
    // older build counted the executor's fee in that cost, and the figure stays as it showed it.
    if (move.direction !== "in" || !burn?.rawAmount || burn.relayerTip === undefined)
      return undefined
    if (!burn.skyMove) return undefined
    const relayerTip = BigInt(burn.relayerTip) + BigInt(burn.skyMove.relayerTip)
    const put = BigInt(burn.rawAmount) - relayerTip
    if (put <= 0n) return undefined
    const figures = { routed: put, relayerTip, conversionOut: put, expectedOut: shares }
    return { ...floors, withdrawalFee: 0n, ...figures }
  }
  const [amount, value, net] = [BigInt(move.amount), BigInt(move.value), BigInt(move.net)]
  if (move.direction === "in") {
    const tips = BigInt(burn?.relayerTip ?? 0) + BigInt(burn?.skyMove?.relayerTip ?? 0)
    const fee = { withdrawalFee: BigInt(burn?.withdrawalFee ?? 0) }
    const figures = { routed: net, relayerTip: tips, conversionOut: net, expectedOut: shares }
    return { ...floors, ...fee, ...figures }
  }
  const routed = value > 0n ? (amount * net) / value : 0n
  const figures = { routed, relayerTip: amount - routed, conversionOut: net, expectedOut: value }
  return { ...floors, withdrawalFee: 0n, ...figures }
}

/**
 * Whether a saved move still searches L1 and kept nothing to start from. A cursor kept without its
 * floor may sit past the deposit, so it is never the start.
 */
const lacksFloor = (move: SavedSavingsMove, burn: SavedBurn | undefined): boolean =>
  move.depositScanFloor === undefined &&
  !!burn?.skyMove &&
  burn.skyMove.depositScanFrom === undefined &&
  SEARCHING.has(phaseOf(move, burn))

/**
 * A saved move as the moves store keeps it, under its burn's id, in the phase its record and burn
 * show. A retired rollup's move that never settled is `migrated`. The vault's figure is its cost.
 * Its search starts at the floor it kept, else the L1 head its burn kept, else `floor`. A move
 * whose burn is no Sky burn, or another factory's, is skipped: the replay rebuilds the first from
 * the chain when it is one, and the second is another deployment's. So is a move that holds a
 * figure or field that does not read, and the log names it and why.
 */
export function savedMoveRecord(
  move: SavedSavingsMove,
  burn: SavedBurn | undefined,
  sky: SkyHoldingRef,
  floor?: bigint,
): MoveRecord | SkippedMove {
  try {
    return placedMoveRecord(move, burn, sky, floor)
  } catch (cause) {
    // The decode boundary: one move's bad figure never stops the rest.
    logger.warn(`[savingsMoves] saved move ${move.withdrawalLocalId} does not convert:`, cause)
    return "malformed"
  }
}

function placedMoveRecord(
  move: SavedSavingsMove,
  burn: SavedBurn | undefined,
  sky: SkyHoldingRef,
  floor: bigint | undefined,
): MoveRecord | SkippedMove {
  // Settling reads the chain by these: a move without one would fail its pass, every pass.
  const named = [move.escrow, move.nonce, move.recipientCommitment]
  if (!named.every((field) => typeof field === "string")) {
    logger.warn(`[savingsMoves] saved move ${move.withdrawalLocalId} lacks a field settling reads`)
    return "malformed"
  }
  const meta = burn?.skyMove
  if (!meta) return "noSkyMeta"
  const factory = move.factory ?? meta?.factory ?? sky.factory
  if (!move.retired && factory.toLowerCase() !== sky.factory.toLowerCase()) return "otherFactory"
  const { deposit } = move
  const phase = phaseOf(move, burn)
  const quote = quoteOf(move, burn)
  const scanFrom =
    move.depositScanFloor ?? meta.depositScanFrom ?? floor ?? move.depositScanFrom ?? "0"
  const l1 = {
    ...(burn?.l1TxHash ? { releaseTx: burn.l1TxHash } : {}),
    ...(deposit?.txHash ? { depositTx: deposit.txHash } : {}),
    ...(move.recovered?.txHashes[0] ? { recoveryTx: move.recovered.txHashes[0] } : {}),
  }
  return {
    id: move.withdrawalLocalId,
    holdingId: sky.id,
    rail: "skyEscrow",
    // A retired move never runs here, so its tip is never paid.
    escrow: { factory, address: move.escrow, tip: BigInt(meta?.relayerTip ?? 0) },
    direction: move.direction,
    amount: BigInt(move.amount),
    ...(quote ? { quote } : {}),
    withdrawalLocalId: move.withdrawalLocalId,
    ...(burn?.withdrawalId ? { withdrawalId: burn.withdrawalId } : {}),
    nonce: move.nonce,
    recipientCommitment: move.recipientCommitment,
    scanFrom: BigInt(scanFrom),
    phase,
    startTime: move.startTime,
    ...(move.endTime === undefined ? {} : { endTime: move.endTime }),
    ...(Object.keys(l1).length ? { l1 } : {}),
    ...(deposit
      ? {
          deposit: {
            inboxIndex: BigInt(deposit.inboxIndex),
            amount: BigInt(deposit.amount),
            at: deposit.at ?? move.endTime ?? move.startTime,
          },
        }
      : {}),
    ...(move.vault ? { assets: BigInt(move.vault.assets) } : {}),
    ...(move.recovered ? { recoveredTo: move.recovered.to } : {}),
    ...(phase === "failed" ? { failure: burn?.failure ?? { code: "withdrawal.failed" } } : {}),
  }
}

/** What the conversion reads besides the database. */
export interface SavedMovesChain {
  /** The Sky holding the moves count in, read only when there are moves to convert. */
  sky: () => Promise<SkyHoldingRef | undefined>
  /** The first L1 block at or after a time, read only for a move that kept no search floor. */
  blockAt: (timeMs: number) => Promise<bigint>
}

/**
 * The active database's saved moves as move records, each burn read from its withdrawal record.
 * Every move skipped is logged with its reason. A move still searching that kept no floor searches
 * from the block an hour before its start, or from the holding's first block when its burn's start
 * time is a guess. With no Sky holding to count the moves in, or no read of that block, it throws,
 * so the store's open fails and the next open converts them. Undefined when the database holds none.
 */
export async function convertSavingsMoves(
  db: Pick<Database, "range" | "getMany">,
  { sky, blockAt }: SavedMovesChain,
): Promise<{ records: MoveRecord[]; skipped: Record<SkippedMove, number> } | undefined> {
  const [stored, [blob]] = await Promise.all([
    db.range(`${SAVINGS_MOVES}/`),
    db.getMany([SAVINGS_MOVES_BLOB]),
  ])
  if (stored.length === 0 && blob === undefined) return undefined
  const values = new Map<string, string>(stored)
  const { moves, damaged } = savedSavingsMoves({
    get: (key) => (key === SAVINGS_MOVES_BLOB ? blob : values.get(key)),
    keys: () => [...values.keys()],
  })
  const skipped: Record<SkippedMove, number> = {
    damaged,
    malformed: 0,
    noSkyMeta: 0,
    otherFactory: 0,
  }
  const records: MoveRecord[] = []
  const holding = moves.length ? await sky() : undefined
  if (moves.length && !holding)
    throw new WalletError(
      "holding.noRoute",
      `${moves.length} saved Savings move(s), no Sky holding`,
    )
  if (holding) {
    const burns = await db.getMany(
      moves.map((m) => `${WITHDRAWALS}/${m.withdrawalLocalId.toLowerCase()}`),
    )
    for (const [i, move] of moves.entries()) {
      const raw = burns[i]
      const burn = raw === undefined ? undefined : (parsed(raw, decodeRecord) as SavedBurn)
      const floor = !lacksFloor(move, burn)
        ? undefined
        : burn?.startTimeEstimated
        ? holding.fromBlock
        : await blockAt(move.startTime - SAVED_START_MARGIN_MS)
      const record = savedMoveRecord(move, burn, holding, floor)
      if (typeof record === "string") skipped[record]++
      else records.push(record)
    }
  }
  for (const [reason, count] of Object.entries(skipped))
    if (count) logger.warn(`[savingsMoves] skipped ${count} saved move(s): ${reason}`)
  return { records, skipped }
}
