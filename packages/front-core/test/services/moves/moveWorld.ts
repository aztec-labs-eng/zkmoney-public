// One account's moves over one fake L1: the real stores on a memory database, the fake ports, and
// the service and passes built over them. A second device shares the L1 and the account's burns.
import type { Address } from "viem"
import { executorRoutes } from "../../../src/core/services/moves/executorRoutes"
import { openMoves } from "../../../src/core/services/moves/openMoves"
import { replayPass } from "../../../src/core/services/moves/replayMoves"
import { settlePass, type MovesDeps } from "../../../src/core/services/moves/settleMoves"
import {
  bindRail,
  type BoundRail,
  type MovePorts,
  type MoveRoutes,
  type MovesAccount,
} from "../../../src/core/services/moves/types"
import { openDatabase } from "../../../src/engine/database"
import { memoryBackend } from "../../../src/engine/memoryBackend"
import { createMoveStore } from "../../../src/engine/moves"
import type { MoveRecord } from "../../../src/engine/moveTransition"
import { fixed } from "../../../src/engine/service"
import { memoryStore } from "../../../src/engine/store"
import { createWithdrawals } from "../../../src/engine/withdrawals"
import {
  DAI_PORTAL,
  FEED,
  fakeAccount,
  fakeEscrowRoutes,
  fakeL1,
  frontAccount,
  SKY_HOLDING,
  VAULT_HOLDING,
  type FakeEscrowHolding,
  type FakeEscrowQuote,
  type FakeEscrowRoute,
  type FakeL1,
} from "./fixtures"

type EscrowRoutes = MoveRoutes<FakeEscrowHolding, FakeEscrowRoute, FakeEscrowQuote>

export const L1_START = { number: 7n, timeMs: 1_700_000_000_000 }

export interface WorldOptions {
  l1?: FakeL1
  /** The account's L2 side, shared by a second device. */
  account?: MovesAccount
  /** What the account holds, by portal; 1,000 DAI base units by default. */
  balances?: Record<Address, bigint>
  burns?: "sent" | "refused" | "failed"
  /** Wraps the escrow port, to count or hide its reads. */
  routes?: (routes: EscrowRoutes) => EscrowRoutes
  /** The holdings the wallet lists; the rail's holding by default. */
  listed?: readonly string[]
  /** The rail the world moves on: Sky's escrows by default, or a vault's multi-step executor. */
  rail?: "skyEscrow" | "executor"
  /** Binds no rail until `bind()`, as a wallet does for a rail it learns to bind later. */
  unbound?: boolean
}

export async function moveWorld(opts: WorldOptions = {}) {
  const l1 = opts.l1 ?? fakeL1(L1_START)
  const clock = { now: L1_START.timeMs }
  const now = () => clock.now
  const db = openDatabase(memoryBackend())
  const moves = createMoveStore(db)
  const withdrawals = createWithdrawals({ db, now })
  const account = opts.account ?? fakeAccount(l1, opts.balances ?? { [DAI_PORTAL]: 1_000n }, now)
  const escrow = fakeEscrowRoutes(l1)
  const routes = opts.routes ? opts.routes(escrow) : escrow
  const rail =
    opts.rail === "executor"
      ? bindRail({
          routes: executorRoutes({ l1: l1.client, eth: { feed: FEED } }),
          holdings: [VAULT_HOLDING],
          listed: new Set(opts.listed ?? [VAULT_HOLDING.id]),
        })
      : bindRail({
          routes,
          holdings: [SKY_HOLDING],
          listed: new Set(opts.listed ?? [SKY_HOLDING.id]),
        })
  const rails = memoryStore<readonly BoundRail[]>(opts.unbound ? [] : [rail])
  const ports: MovePorts = {
    rails: rails.readonly,
    account: frontAccount(account, withdrawals, now, opts.burns),
  }
  const deps: MovesDeps = { db, moves, withdrawals, now }
  const service = await openMoves({ ...deps, ports: fixed("ports", ports) }).ready()
  const signal = new AbortController().signal
  const read = async (id: string): Promise<MoveRecord> => {
    const record = await moves.get(id)
    if (!record) throw new Error(`no move ${id}`)
    return record
  }
  return {
    l1,
    clock,
    db,
    moves,
    withdrawals,
    account,
    ports,
    deps,
    service,
    read,
    settle: () => settlePass({ ...deps, refreshBalance: async () => undefined }, ports, signal),
    replay: () => replayPass(deps, ports, signal),
    bind: () => rails.set([rail]),
    /** The move's withdrawal id, as its burn's record holds it. */
    withdrawalId: async (move: MoveRecord) =>
      move.withdrawalId ?? (await withdrawals.get(move.withdrawalLocalId ?? ""))?.withdrawalId,
  }
}

export type MoveWorld = Awaited<ReturnType<typeof moveWorld>>

/**
 * What a relayer does for a move whose release spends `withdrawalId`: the release, unless it was
 * made, then the escrow's run, which deposits `deposit` into the destination portal for `assets`,
 * `gap` blocks after the run.
 */
export async function runRoute(
  world: Pick<MoveWorld, "l1" | "withdrawalId">,
  move: MoveRecord,
  { assets, deposit, gap = 0 }: { assets: bigint; deposit: bigint; gap?: number },
) {
  if (move.rail !== "skyEscrow") throw new Error("the fake runs escrows only")
  const { base, held } = SKY_HOLDING
  const [source, destination] = move.direction === "in" ? [base, held] : [held, base]
  const withdrawalId = await world.withdrawalId(move)
  if (!withdrawalId) throw new Error(`move ${move.id} has no withdrawal id`)
  if (!world.l1.spentOn(source.portal as Address, withdrawalId))
    await world.l1.release(source.portal as Address, withdrawalId)
  const { escrow } = move
  const ran = await world.l1.run(
    { rail: "skyEscrow", escrow, target: escrow.address, withdrawal: {}, releaseTip: 0n },
    assets,
  )
  for (let i = 0; i < gap; i++) await world.l1.mine()
  const made = await world.l1.deposit(
    destination.portal as Address,
    move.recipientCommitment,
    deposit,
  )
  return { ran, made }
}

/**
 * What a relayer does for a vault move: one tx that releases the withdrawal, runs the route and
 * ends in the destination portal's deposit of `deposit` for the vault's `assets`.
 */
export async function runVaultRoute(
  world: Pick<MoveWorld, "l1" | "withdrawalId">,
  move: MoveRecord,
  { assets, deposit }: { assets: bigint; deposit: bigint },
) {
  if (move.rail !== "executor") throw new Error("not a vault move")
  const { base, held } = VAULT_HOLDING
  const source = move.direction === "in" ? base : held
  const withdrawalId = await world.withdrawalId(move)
  if (!withdrawalId) throw new Error(`move ${move.id} has no withdrawal id`)
  return world.l1.executorRun(move.direction, move.recipientCommitment, {
    assets: [assets],
    deposited: deposit,
    release: { portal: source.portal as Address, withdrawalId },
  })
}
