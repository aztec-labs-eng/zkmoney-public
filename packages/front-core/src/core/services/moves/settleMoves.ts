import type { Hash, Hex } from "viem"
import type { Database } from "../../../engine/database"
import { bestEffort, WalletError } from "../../../engine/errors"
import { moveScanRange, scannedTo } from "../../../engine/moveScanCursor"
import type { MoveStore } from "../../../engine/moves"
import type { MoveEvent, MoveQuote, MoveRail, MoveRecord } from "../../../engine/moveTransition"
import { task, type Task } from "../../../engine/runtime"
import type { Service } from "../../../engine/service"
import { WITHDRAWAL_SUBMIT_TIMEOUT_MS, type Withdrawals } from "../../../engine/withdrawals"
import type {
  BlockRange,
  MovePorts,
  MoveRoute,
  MoveRoutes,
  MovesAccount,
  RailFields,
  RailMove,
  RouteHolding,
} from "./types"

export const MOVES_SETTLE_MS = 10_000
const MOVES_SETTLE_HIDDEN_MS = 30_000
const SETTLE_BACKOFF = { baseMs: MOVES_SETTLE_MS, maxMs: 10 * 60_000 }

/** What the moves' tasks and service write and read besides the ports. */
export interface MovesDeps {
  /** The account's database, which holds the move store. */
  db: Database
  moves: MoveStore
  withdrawals: Pick<Withdrawals, "get">
  now: () => number
}

/** What settling needs besides the moves' own deps. */
export interface SettleDeps extends MovesDeps {
  /** Reads the account's balances again: once a claim is recorded, so its funds count once. */
  refreshBalance: () => Promise<void>
}

/** A holding with its rail's port and its route as that port reads it, in the port's types. */
export interface HoldingRoute<H extends RouteHolding, R extends MoveRoute, Q extends MoveQuote> {
  holding: H
  routes: MoveRoutes<H, R, Q>
  route: R
}

/** Whether `move` runs on `rail`, which the port serving its holding names. */
export function onRail<Rail extends MoveRail>(
  move: MoveRecord,
  rail: Rail,
): move is MoveRecord & RailMove<Rail> {
  return move.rail === rail
}

/** The release of a move no burn record times, once found in `range`. */
async function releaseSeen<R extends MoveRoute>(
  routes: Pick<MoveRoutes<RouteHolding, R>, "release">,
  route: R,
  move: MoveRecord,
  withdrawalId: Hex,
  range: BlockRange,
): Promise<MoveEvent | undefined> {
  if (move.withdrawalLocalId !== undefined || move.releasedAt !== undefined) return undefined
  const found = await routes.release(route, move.direction, withdrawalId, range)
  return found && { type: "releaseSeen", txHash: found.txHash, at: found.at }
}

/**
 * What L1 shows of a move: its release, read by `withdrawalId` until the move is released, its
 * route's run or recovery, and its deposit, one bounded range a pass. A run and the deposit it
 * makes are searched from the same cursor. `rail`: the move's rail fields, in the port's types.
 * `signal` aborts the range's reads. `releaseTx`: the release's hash, where the burn's record has
 * it.
 */
export async function chainEvents<H extends RouteHolding, R extends MoveRoute, Q extends MoveQuote>(
  { routes, route }: Pick<HoldingRoute<H, R, Q>, "routes" | "route">,
  move: MoveRecord,
  rail: RailFields<H["rail"]>,
  withdrawalId: Hex | undefined,
  head: bigint,
  at: number,
  signal: AbortSignal,
  releaseTx?: Hash,
): Promise<MoveEvent[]> {
  const range = moveScanRange(move, head)
  const to = range && scannedTo(move.scanFrom, range.to, head)
  const scanned: MoveEvent[] = to === undefined ? [] : [{ type: "scanned", to }]
  const released: MoveEvent[] = []
  if (move.phase === "burning" || move.phase === "burned") {
    if (withdrawalId === undefined) return []
    if (!(await routes.withdrawalSpent(route, move.direction, withdrawalId))) {
      return [{ type: "observed", limits: await routes.limits(route), at }]
    }
    const seen = range && (await releaseSeen(routes, route, move, withdrawalId, range))
    if (seen) released.push(seen)
    const outcome =
      range &&
      (await routes.outcome(
        route,
        {
          ...rail,
          direction: move.direction,
          recipientCommitment: move.recipientCommitment,
          withdrawalId,
        },
        range,
        signal,
      ))
    if (outcome?.kind === "recovered") {
      return [{ type: "recovered", txHash: outcome.txHash, to: outcome.to, at }]
    }
    if (outcome?.kind !== "ran") {
      return [...released, ...scanned, { type: "observed", limits: await routes.limits(route), at }]
    }
    released.push({ type: "released", txHash: releaseTx, assets: outcome.assets })
  }
  const found =
    range &&
    (await routes.findDeposit(route, move.direction, move.recipientCommitment, range, signal))
  if (!found) return [...released, ...scanned]
  return [...released, { type: "depositSeen", txHash: found.txHash, deposit: found.deposit }]
}

/** Applies `events` to the move in one transaction, through its transition. */
async function commit(deps: MovesDeps, id: string, events: readonly MoveEvent[]) {
  if (events.length === 0) return undefined
  return deps.db.write(async (w) => {
    let record: MoveRecord | undefined
    for (const event of events) record = (await deps.moves.apply(id, event, w)) ?? record
    return record
  })
}

/** What the burn's record, saved under `localId`, says of a move started at `startTime`. */
async function burnEvents(
  deps: MovesDeps,
  localId: string,
  startTime: number,
  at: number,
): Promise<{ events: MoveEvent[]; withdrawalId?: Hex; releaseTx?: Hash }> {
  const burn = await deps.withdrawals.get(localId)
  if (!burn) {
    // The record is seeded after the move: a move this young may still be proving.
    const stale = at - startTime >= WITHDRAWAL_SUBMIT_TIMEOUT_MS
    return { events: stale ? [{ type: "dropped", at }] : [] }
  }
  if (burn.phase === "failed") {
    // A burn a reorg dropped may yet be seen included.
    if (burn.droppedBurn) return { events: [] }
    const failure = burn.failure ?? { code: "withdrawal.failed" }
    return { events: [{ type: "failed", failure, at }] }
  }
  if (burn.blockNumber === undefined) return { events: [] }
  return {
    events: [{ type: "burnMined" }],
    withdrawalId: burn.withdrawalId,
    releaseTx: burn.l1TxHash,
  }
}

/**
 * Saves what the burn's record and one bounded read of L1 show of `move`. The move as it is then,
 * or undefined when the read changed nothing.
 */
async function readMove<H extends RouteHolding, R extends MoveRoute, Q extends MoveQuote>(
  deps: MovesDeps,
  at: HoldingRoute<H, R, Q>,
  move: MoveRecord & RailMove<H["rail"]>,
  head: Promise<bigint>,
  signal: AbortSignal,
): Promise<(MoveRecord & RailMove<H["rail"]>) | undefined> {
  const now = deps.now()
  const burn =
    move.withdrawalLocalId === undefined
      ? { events: [], withdrawalId: move.withdrawalId }
      : await burnEvents(deps, move.withdrawalLocalId, move.startTime, now)
  const ended = burn.events.some((e) => e.type === "dropped" || e.type === "failed")
  const chain = ended
    ? []
    : await chainEvents(at, move, move, burn.withdrawalId, await head, now, signal, burn.releaseTx)
  const saved = await commit(deps, move.id, [...burn.events, ...chain])
  return saved && onRail(saved, at.routes.rail) ? saved : undefined
}

/**
 * `move` as L1 shows it up to `head`: read a bounded range at a time until its route has run, it has
 * ended, or the search is at the head. A command that acts on a move not yet released reads it so
 * first, since a settle pass searches only one range. `signal` aborts the reads.
 */
export async function moveAtHead<H extends RouteHolding, R extends MoveRoute, Q extends MoveQuote>(
  deps: MovesDeps,
  at: HoldingRoute<H, R, Q>,
  move: MoveRecord & RailMove<H["rail"]>,
  head: bigint,
  signal: AbortSignal,
): Promise<MoveRecord & RailMove<H["rail"]>> {
  let current = move
  while (current.phase === "burning" || current.phase === "burned") {
    const range = moveScanRange(current, head)
    // A read that changed nothing may have read a copy a settle pass has since moved on.
    const held =
      (await readMove(deps, at, current, Promise.resolve(head), signal)) ??
      (await deps.moves.get(move.id))
    const next = held && onRail(held, at.routes.rail) ? held : current
    const searched = !range || range.to >= head
    // An unspent release leaves the cursor where it was: the route cannot have run.
    if (searched || (next.phase === current.phase && next.scannedTo === current.scannedTo))
      return next
    current = next
  }
  return current
}

/**
 * Carries one move as far as the chain allows, then claims its deposit once its message is on L2.
 * Until then the move stays `depositSeen` for a later pass.
 */
async function settleMove<H extends RouteHolding, R extends MoveRoute, Q extends MoveQuote>(
  deps: SettleDeps,
  account: MovesAccount,
  at: HoldingRoute<H, R, Q>,
  move: MoveRecord & RailMove<H["rail"]>,
  head: () => Promise<bigint>,
  signal: AbortSignal,
): Promise<void> {
  const record =
    move.phase === "depositSeen" ? move : await readMove(deps, at, move, head(), signal)
  if (record?.phase !== "depositSeen" || !record.deposit) return
  // A deposit an older build's record carried has no message key: its claim tells, and one made
  // early is the move's own fault, left to the next pass.
  const { messageKey } = record.deposit
  if (messageKey && !(await account.messageReady(messageKey))) return
  const destination = record.direction === "in" ? at.holding.held : at.holding.base
  const { recipient } = account.salts(record.nonce, record.rail)
  await account.claim(destination, { ...record.deposit, secret: recipient }, signal)
  await deps.moves.apply(record.id, { type: "claimed", at: deps.now() })
  await bestEffort("balance.unread", deps.refreshBalance())
}

/**
 * Settles one holding's open moves over its route, read once. A move's own fault, in its reads or
 * its claim, is logged and left to the next pass: it never holds back another move or the cadence.
 * The route and the head are every move's reads, so their failure fails the pass.
 */
async function settleHolding<H extends RouteHolding, R extends MoveRoute, Q extends MoveQuote>(
  deps: SettleDeps,
  account: MovesAccount,
  { routes, holding }: Pick<HoldingRoute<H, R, Q>, "routes" | "holding">,
  moves: readonly (MoveRecord & RailMove<H["rail"]>)[],
  head: () => Promise<bigint>,
  signal: AbortSignal,
): Promise<void> {
  const at = { holding, routes, route: await routes.read(holding) }
  if (moves.some((move) => move.phase !== "depositSeen")) await head()
  for (const move of moves) {
    // An abort is the pass's end, not a move's fault.
    signal.throwIfAborted()
    await bestEffort("unknown", settleMove(deps, account, at, move, head, signal))
  }
  signal.throwIfAborted()
}

/**
 * One pass over every open move, each holding's route read once. Every port reads the same L1,
 * whose head is read once a pass. A holding whose route or head read fails leaves the others their
 * pass; the first such failure then fails it, as does a move no bound rail serves.
 */
export async function settlePass(
  deps: SettleDeps,
  ports: MovePorts,
  signal: AbortSignal,
): Promise<void> {
  await deps.moves.ready
  const open = await deps.moves.open()
  let read: Promise<bigint> | undefined
  const failures: unknown[] = []
  let served = 0
  for (const bound of ports.rails.get()) {
    const head = () => (read ??= bound(({ routes }) => routes.head()))
    await bound(async ({ routes, holdings }) => {
      for (const holding of holdings) {
        const moves = open.filter(
          (move): move is MoveRecord & RailMove<typeof routes.rail> =>
            move.holdingId === holding.id && onRail(move, routes.rail),
        )
        served += moves.length
        if (moves.length === 0 || signal.aborted) continue
        try {
          await settleHolding(deps, ports.account, { routes, holding }, moves, head, signal)
        } catch (error) {
          failures.push(error)
        }
      }
    })
  }
  if (failures.length > 0) throw failures[0]
  if (served < open.length) {
    throw new WalletError("holding.noRoute", `${open.length - served} open moves have no port`)
  }
}

/**
 * Settles the open moves every 10 s once the first balance is in, and every 30 s in a hidden tab,
 * so a move the user left running still ends; a failed pass backs off.
 */
export function settleMoves(deps: SettleDeps & { ports: Service<MovePorts> }): Task {
  return task("settleMoves", {
    needs: { ports: deps.ports },
    after: { firstBalance: true },
    every: MOVES_SETTLE_MS,
    whenHidden: MOVES_SETTLE_HIDDEN_MS,
    backoff: SETTLE_BACKOFF,
    run: ({ ports, signal }) => settlePass(deps, ports, signal),
  })
}
