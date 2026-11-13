// A fresh device has no record of the account's moves, so the deposits they made count in no
// balance until each is claimed. The burns' recovery events carry each move's nonce, which derives
// the deposit's claim secret.
import type { OxideBridge } from "@obsidion/core/oxide"
import { WalletError } from "../../../engine/errors"
import type { Milestones } from "../../../engine/milestones"
import type {
  MoveDirection,
  MoveEvent,
  MoveQuote,
  ReplayedMove,
} from "../../../engine/moveTransition"
import { loadRecords } from "../../../engine/persistentStore"
import { logger } from "../../../utils/logger"
import { task, within, type Task } from "../../../engine/runtime"
import type { Service } from "../../../engine/service"
import { boundRails } from "./openMoves"
import { chainEvents, type MovesDeps } from "./settleMoves"
import type {
  MoveBurn,
  MovePorts,
  MoveRoute,
  MoveRoutes,
  MovesAccount,
  RailPorts,
  RouteHolding,
} from "./types"

/** An L2 block's time may run ahead of L1's clock: the deposit search starts this much before. */
export const REPLAY_CLOCK_MARGIN_MS = 60 * 60_000
const lower = (hex: string) => hex.toLowerCase()
const REPLAY_BACKOFF = { baseMs: 30_000, maxMs: 60 * 60_000 }

/** The record a burn rebuilds, burned, before the chain's events carry it on. */
function burnedMove(
  holding: RouteHolding,
  direction: MoveDirection,
  burn: MoveBurn,
  scanFrom: bigint,
): ReplayedMove {
  const { txHash, timestampMs, withdrawalId, amount, nonce, recipientCommitment, ...rail } = burn
  return {
    ...rail,
    id: `replayed-${txHash}`,
    holdingId: holding.id,
    direction,
    amount,
    nonce,
    recipientCommitment,
    scanFrom,
    withdrawalId,
    phase: "burned",
    startTime: timestampMs,
    replayedFrom: txHash,
  }
}

/** The holding and direction whose move `burn`, read from `bridge`, is. */
function ownerOf<H extends RouteHolding, R extends MoveRoute, Q extends MoveQuote>(
  routes: MoveRoutes<H, R, Q>,
  routed: readonly { holding: H; route: R }[],
  bridge: OxideBridge,
  burn: MoveBurn,
) {
  for (const { holding, route } of routed) {
    for (const direction of ["in", "out"] as const) {
      const source = direction === "in" ? holding.base : holding.held
      if (lower(source.portal) !== lower(bridge.portal)) continue
      if (routes.owns(route, burn)) return { holding, route, direction, burn }
    }
  }
  return undefined
}

/**
 * What a replay pass wrote, whether a burn it needs was not yet indexed, and how many burns it
 * skipped: no holding's route owns them, or their deposit does not open to this account's secret.
 */
export interface ReplayResult {
  written: number
  unread: boolean
  skipped: number
}

function skip(result: ReplayResult, burn: MoveBurn, why: string) {
  result.skipped++
  logger.warn(`[replayMoves] skipped burn ${burn.txHash}: ${why}`)
}

/** Writes the rail's moves that no record holds. */
async function replayRail<H extends RouteHolding, R extends MoveRoute, Q extends MoveQuote>(
  deps: MovesDeps,
  account: MovesAccount,
  { routes, holdings }: RailPorts<H, R, Q>,
  known: Set<string>,
  head: () => Promise<bigint>,
  signal: AbortSignal,
): Promise<ReplayResult> {
  const routed: { holding: H; route: R }[] = []
  for (const holding of holdings) routed.push({ holding, route: await routes.read(holding) })
  const sources = holdings.flatMap((h) => [h.base, h.held])
  const bridges = sources.filter(
    (b, i) => sources.findIndex((o) => lower(o.portal) === lower(b.portal)) === i,
  )
  const result: ReplayResult = { written: 0, unread: false, skipped: 0 }
  for (const bridge of bridges) {
    const { burns, unread } = await account.moveBurns(bridge, routes.rail)
    result.unread ||= unread
    for (const read of burns) {
      if (signal.aborted) return result
      if (known.has(lower(read.nonce))) continue
      const owner = ownerOf(routes, routed, bridge, read)
      if (!owner) {
        skip(result, read, "no holding's route owns it")
        continue
      }
      const { holding, route, direction, burn } = owner
      const { recipient } = account.salts(burn.nonce, burn.rail)
      const commitment = await routes.commitment(recipient, account.address)
      if (lower(commitment) !== lower(burn.recipientCommitment)) {
        skip(result, read, "its deposit does not open to this account's secret")
        continue
      }
      const scanFrom = await routes.blockAt(burn.timestampMs - REPLAY_CLOCK_MARGIN_MS)
      const move = burnedMove(holding, direction, burn, scanFrom)
      const at = deps.now()
      const chain = await chainEvents(
        { routes, route },
        move,
        burn,
        move.withdrawalId,
        await head(),
        at,
        signal,
      )
      const events: MoveEvent[] = [{ type: "replayed", record: move }, ...chain]
      const wrote = await deps.db.write(async (w) => {
        // Writes run one at a time, so a move `add` or `withdraw` saved during the reads is here.
        const saved = await loadRecords(deps.moves.view)
        if (saved.some((r) => lower(r.nonce) === lower(burn.nonce))) return false
        for (const event of events) await deps.moves.apply(move.id, event, w)
        return true
      })
      known.add(lower(burn.nonce))
      if (wrote) result.written++
    }
  }
  return result
}

/**
 * Writes every move the account's burns made that no record holds, each with what L1 shows of it
 * in one write: its release, its route's run or recovery, and its deposit, from the first range of
 * its search. Each port reads its rail's burns from the holdings' bridges and says which are its
 * own. A burn the node has not indexed is read on a later pass; a move's record is never removed.
 */
export async function replayPass(
  deps: MovesDeps,
  ports: MovePorts,
  signal: AbortSignal,
): Promise<ReplayResult> {
  await deps.moves.ready
  const known = new Set((await loadRecords(deps.moves.view)).map((r) => lower(r.nonce)))
  let read: Promise<bigint> | undefined
  const result: ReplayResult = { written: 0, unread: false, skipped: 0 }
  for (const bound of ports.rails.get()) {
    const head = () => (read ??= bound(({ routes }) => routes.head()))
    const rail = await bound((r) => replayRail(deps, ports.account, r, known, head, signal))
    result.written += rail.written
    result.unread ||= rail.unread
    result.skipped += rail.skipped
  }
  return result
}

/**
 * Rebuilds the account's moves once per session, after the first balance and the deposits' replay.
 * It then wakes `settle` and waits for its run, which claims the replayed deposits, so the boot sync
 * ends with them in, and marks `movesReplayed`. A failed pass backs off, as does one that met a burn
 * the node has not indexed, until a pass reads every burn; the milestone's own bound stops the boot
 * waiting on it. A rail bound later, such as a vault the account is found to hold, replays again.
 */
export function replayMoves(
  deps: MovesDeps & {
    ports: Service<MovePorts>
    milestones: Pick<Milestones, "mark">
    settle: Task
  },
): Task {
  return task("replayMoves", {
    needs: { ports: deps.ports },
    on: { rails: boundRails(deps.ports) },
    after: { firstBalance: true, depositsReplayed: { whenCatchingUp: 0 } },
    every: "once",
    backoff: REPLAY_BACKOFF,
    async run({ ports, signal, wake }) {
      const { unread } = await replayPass(deps, ports, signal)
      await within(wake(deps.settle), "replayMoves", { signal })
      if (signal.aborted) return
      deps.milestones.mark("movesReplayed")
      if (unread) throw new WalletError("scan.incomplete", "a move's burn is not indexed yet")
    },
  })
}
