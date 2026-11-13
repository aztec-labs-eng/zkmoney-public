import type { Address, Hash } from "viem"
import { bytesToHex } from "viem"
import { bestEffort, WalletError } from "../../../engine/errors"
import { liveStore } from "../../../engine/liveStore"
import { selectMoveState } from "../../../engine/moveState"
import type { MoveDirection, MoveQuote, MoveRail, MoveRecord } from "../../../engine/moveTransition"
import { service, type Service } from "../../../engine/service"
import type { ReadonlyStore } from "../../../engine/store"
import { newWithdrawalLocalId } from "../../../engine/withdrawals"
import { moveAtHead, onRail, type MovesDeps } from "./settleMoves"
import type { BoundRail, MovePorts, MoveRoute, MoveRoutes, RouteHolding } from "./types"

/**
 * The commands a view's flow runs on the account's moves. A `watch` goes to the account that makes
 * the command's L1 send.
 */
export interface Moves<Watch = never> {
  /**
   * Moves `amount` of the base's token into the holding; resolves once its burn is mined. Refuses
   * a holding the wallet does not list with `move.exitOnly`. With `reviewed`, refuses with
   * `move.quoteChanged` before anything is sent when less would now land.
   * An abort of `signal` before the burn proves sends nothing, and the move ends `dropped`.
   */
  add(
    holdingId: string,
    amount: bigint,
    operationId: string,
    reviewed?: MoveQuote,
    signal?: AbortSignal,
  ): Promise<MoveRecord>
  /** Moves `amount` of the holding's token to its base, as `add` does. */
  withdraw(
    holdingId: string,
    amount: bigint,
    operationId: string,
    reviewed?: MoveQuote,
    signal?: AbortSignal,
  ): Promise<MoveRecord>
  /**
   * Sends the move's funds back to `to` on L1; resolves to the mined recovery's hash. Refused with
   * `move.noRecovery` before the move's release: its escrow holds nothing of the move yet. Reads
   * the move up to the L1 head before it sends and before it records: a move whose route ran takes
   * the run's phase, and the recovery is refused with `move.escrowRan`. A mined recovery whose
   * second read fails resolves unrecorded, and the settle pass records what L1 shows.
   */
  recover(moveId: string, to: Address, watch?: Watch): Promise<Hash>
  /** Runs the move's route as its relayer would; resolves to the mined run's hash. */
  run(moveId: string, watch?: Watch): Promise<Hash>
}

const BEFORE_RELEASE: ReadonlySet<MoveRecord["phase"]> = new Set(["burning", "burned"])

const NO_RAILS: readonly BoundRail[] = []

/**
 * The rails `ports` binds: none until they are built, then their rails store, as it changes. What
 * a view or a task's `on` reads.
 */
export function boundRails(
  ports: Service<Pick<MovePorts, "rails">>,
): ReadonlyStore<readonly BoundRail[]> {
  const current = () => {
    const state = ports.get()
    return state.status === "ready" ? state.value.rails.get() : NO_RAILS
  }
  return liveStore(current(), {
    whileSubscribed(set) {
      let followed: ReadonlyStore<readonly BoundRail[]> | undefined
      let unfollow = () => {}
      const follow = () => {
        const state = ports.get()
        const rails = state.status === "ready" ? state.value.rails : undefined
        if (rails !== followed) {
          unfollow()
          followed = rails
          unfollow = rails?.subscribe(() => set(current())) ?? (() => {})
        }
        set(current())
      }
      const off = ports.subscribe(follow)
      follow()
      return () => {
        off()
        unfollow()
      }
    },
  })
}

/** The rails whose port can send a move's funds back before its route runs. */
export const recoverableRails = (rails: readonly BoundRail[]): ReadonlySet<MoveRail> =>
  new Set(
    rails.flatMap((bound) =>
      bound(({ routes }) => (routes.recover === undefined ? [] : [routes.rail])),
    ),
  )

/** The rails whose route anyone can run. */
export const runnableRails = (rails: readonly BoundRail[]): ReadonlySet<MoveRail> =>
  new Set(
    rails.flatMap((bound) =>
      bound(({ routes }) => (routes.run === undefined ? [] : [routes.rail])),
    ),
  )

/** Whether the move's rail can send its funds back, and its route has not run. */
export const selectMoveRecoverable = (
  move: Pick<MoveRecord, "rail" | "phase">,
  rails: ReadonlySet<MoveRail>,
): boolean => BEFORE_RELEASE.has(move.phase) && rails.has(move.rail)

/**
 * Runs `use` with the holding `holdingId` names and its rail's port, in the port's types, and
 * whether the wallet lists the holding.
 */
export async function withHolding<T>(
  ports: MovePorts,
  holdingId: string,
  use: <H extends RouteHolding, R extends MoveRoute, Q extends MoveQuote>(
    routes: MoveRoutes<H, R, Q>,
    holding: H,
    listed: boolean,
  ) => Promise<T>,
): Promise<T> {
  for (const bound of ports.rails.get()) {
    const run = bound(({ routes, holdings, listed }) => {
      const holding = holdings.find((h) => h.id === holdingId)
      return holding && (() => use(routes, holding, listed.has(holding.id)))
    })
    if (run) return run()
  }
  throw new WalletError("holding.noRoute", `no holding ${holdingId}`)
}

function movesOf<Watch>(deps: MovesDeps, ports: MovePorts<Watch>): Moves<Watch> {
  const { account } = ports

  /** Builds the move through its port, saves it, then burns. */
  async function move<H extends RouteHolding, R extends MoveRoute, Q extends MoveQuote>(
    routes: MoveRoutes<H, R, Q>,
    holding: H,
    direction: MoveDirection,
    amount: bigint,
    operationId: string,
    reviewed: MoveQuote | undefined,
    signal: AbortSignal | undefined,
  ): Promise<MoveRecord> {
    const route = await routes.read(holding)
    const [quote, scanFrom] = await Promise.all([
      routes.quote(route, direction, amount),
      routes.head(),
    ])
    if (reviewed && quote.conversionOut < reviewed.conversionOut) {
      throw new WalletError(
        "move.quoteChanged",
        `${quote.conversionOut} < ${reviewed.conversionOut}`,
      )
    }
    const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
    const salts = account.salts(nonce, holding.rail)
    const recipientCommitment = await routes.commitment(salts.recipient, account.address)
    const recovery = { salt: salts.recovery, account: account.recoveryAccount }
    const args = { direction, amount, from: account.address, nonce, recipientCommitment, recovery }
    const { target, withdrawal, releaseTip, ...rail } = routes.build(route, args, quote)
    const startTime = deps.now()
    const id = newWithdrawalLocalId(startTime)
    const record = {
      ...rail,
      id,
      holdingId: holding.id,
      direction,
      amount,
      nonce,
      recipientCommitment,
    }
    const built = await deps.moves.apply(id, {
      type: "built",
      record: { ...record, quote, scanFrom, startTime, withdrawalLocalId: id },
    })
    if (!built) throw new WalletError("invariant", `move ${id} exists`)
    const source = direction === "in" ? holding.base : holding.held
    const request = {
      operationId,
      withdrawalLocalId: id,
      holdingId: holding.id,
      nonce,
      direction,
      source,
      amount,
      target,
      withdrawal,
      releaseTip,
    }
    try {
      await account.burn(request, signal)
    } catch (error) {
      // A burn whose record was dropped never went out; one kept settles through it.
      if (!(await deps.withdrawals.get(id))) {
        await deps.moves.apply(id, { type: "dropped", at: deps.now() })
      }
      throw error
    }
    return (await deps.moves.apply(id, { type: "burnMined" })) ?? built
  }

  return {
    add: (holdingId, amount, operationId, reviewed, signal) =>
      withHolding(ports, holdingId, (routes, holding, listed) => {
        if (!listed) throw new WalletError("move.exitOnly", holdingId)
        return move(routes, holding, "in", amount, operationId, reviewed, signal)
      }),
    withdraw: (holdingId, amount, operationId, reviewed, signal) =>
      withHolding(ports, holdingId, (routes, holding) =>
        move(routes, holding, "out", amount, operationId, reviewed, signal),
      ),
    async recover(moveId, to, watch) {
      const record = await deps.moves.get(moveId)
      if (!record) throw new WalletError("invariant", `no move ${moveId}`)
      return withHolding(ports, record.holdingId, async (routes, holding) => {
        const { recover } = routes
        if (!recover || !onRail(record, routes.rail) || !BEFORE_RELEASE.has(record.phase)) {
          throw new WalletError("move.noRecovery", `${moveId}: ${record.rail}, ${record.phase}`)
        }
        const at = { holding, routes, route: await routes.read(holding) }
        const burn =
          record.withdrawalLocalId === undefined
            ? undefined
            : await deps.withdrawals.get(record.withdrawalLocalId)
        const withdrawalId = record.withdrawalId ?? burn?.withdrawalId
        const spent = async () =>
          withdrawalId !== undefined &&
          (await routes.withdrawalSpent(at.route, record.direction, withdrawalId))
        // The command has no run to abort its reads.
        const { signal } = new AbortController()
        const atHead = async (move: typeof record) =>
          moveAtHead(deps, at, move, await routes.head(), signal)
        const salts = account.salts(record.nonce, record.rail)
        const keys = { salt: salts.recovery, account: account.recoveryAccount, ...account.recovery }
        const source = record.direction === "in" ? holding.base : holding.held
        const release = (executor: Address, tipRecipient: Address) => {
          const txHash = burn?.l2TxHash ?? record.replayedFrom
          if (txHash === undefined) throw new WalletError("move.noRecovery", `${moveId}: no burn`)
          return account.releaseArgs({ txHash, source, executor }, tipRecipient)
        }
        const recovered = async (txHash: Hash) => {
          // The check may have saved the same recovery from L1 first; the transition keeps one.
          await deps.moves.apply(moveId, { type: "recovered", txHash, to, at: deps.now() })
          return txHash
        }

        if (record.rail === "executor") {
          // A route that cannot run reverts its release, so the withdrawal waits unspent and the
          // recovery releases it. It is offered on the wait a stuck Sky move's is.
          const current = await atHead(record)
          const state = selectMoveState(current, burn, deps.now())
          const waited = state.kind === "delayed" && state.dropped
          if (!BEFORE_RELEASE.has(current.phase) || !waited || (await spent()))
            throw new WalletError("move.noRecovery", `${moveId}: ${current.phase}, ${state.kind}`)
          const call = await recover(at.route, current, keys, to, release)
          try {
            return await recovered(await account.recovery.send(call, to, watch))
          } catch (error) {
            // A release that spent the withdrawal first reverts the recovery; the move settles.
            if (!(await bestEffort("unknown", spent()))) throw error
            await bestEffort("unknown", atHead(current))
            throw new WalletError("move.noRecovery", `${moveId}: released first`, { cause: error })
          }
        }

        // Before its release nothing of the move is in its escrow, whatever the escrow holds.
        if (!(await spent())) throw new WalletError("move.noRecovery", `${moveId}: not released`)
        // A route that ran wins: its escrow can hold the token again, which is not the move's.
        const refuseRun = ({ phase }: Pick<MoveRecord, "phase">) => {
          if (phase === "released" || phase === "depositSeen")
            throw new WalletError("move.escrowRan", moveId)
        }
        const current = await atHead(record)
        refuseRun(current)
        if (!BEFORE_RELEASE.has(current.phase))
          throw new WalletError("move.noRecovery", `${moveId}: ${current.phase}`)
        const call = await recover(at.route, current, keys, to, release)
        const txHash = await account.recovery.send(call, to, watch)
        // The route may have run while the recovery was signed. A check that cannot read L1
        // records nothing: the recovery is mined, and the settle pass reads which it was.
        const after = await bestEffort("unknown", atHead(current))
        if (!after) return txHash
        refuseRun(after)
        return recovered(txHash)
      })
    },

    // The settle pass reads the run from L1, as it reads a relayer's.
    async run(moveId, watch) {
      const record = await deps.moves.get(moveId)
      if (!record) throw new WalletError("invariant", `no move ${moveId}`)
      // What the signer is shown: the escrow the run empties.
      const shown = record.rail === "skyEscrow" ? record.escrow.address : undefined
      return withHolding(ports, record.holdingId, async (routes, holding) => {
        if (!routes.run || !onRail(record, routes.rail))
          throw new WalletError("invariant", `${moveId}: no run on ${record.rail}`)
        if (!BEFORE_RELEASE.has(record.phase)) throw new WalletError("move.escrowRan", moveId)
        const salts = account.salts(record.nonce, record.rail)
        const keys = { salt: salts.recovery, account: account.recoveryAccount }
        const call = await routes.run(await routes.read(holding), record, keys)
        return account.runRoute(call, shown ?? call.to, watch)
      })
    },
  }
}

/** The account's moves, built once the ports are bound and rebuilt when they change. */
export function openMoves<Watch = never>(
  deps: MovesDeps & { ports: Service<MovePorts<Watch>> },
): Service<Moves<Watch>> {
  return service("moves", { from: [deps.ports], retry: "manual" }, async ([ports]) =>
    movesOf(deps, ports),
  )
}
