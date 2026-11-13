// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import type { Address } from "viem"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { SWAP_STUCK_THRESHOLD_MS } from "../../../src/core/services/bridge/withdrawalPhases"
import { moveExitOffer } from "../../../src/engine/feedRules"
import type { MovesAccount } from "../../../src/core/services/moves/types"
import { holdingEarned, holdingLedger } from "../../../src/engine/holdingLedger"
import { selectMoveState } from "../../../src/engine/moveState"
import type { MoveItem } from "../../../src/engine/activityFeed"
import { feedOf } from "../../engine/feedFixtures"
import { SKY_HOLDING } from "./fixtures"
import { moveWorld, runRoute, type MoveWorld } from "./moveWorld"

const SKY = SKY_HOLDING.id
const TO = `0x${"0d".repeat(20)}` as Address
const OTHER_FACTORY = `0x${"ac".repeat(20)}` as Address

/** What the Savings feed shows of each move, whichever device built it. */
async function savingsFeed(world: MoveWorld) {
  const moves = (await world.moves.view.get()).records
  const withdrawals = (await world.withdrawals.list.get()).records
  const shown = (item: MoveItem) => ({
    nonce: item.move.nonce,
    direction: item.move.direction,
    amount: item.move.amount,
    phase: item.move.phase,
    state: item.state.kind,
    deposit: item.move.deposit?.amount,
    assets: item.move.assets,
    recoveredTo: item.move.recoveredTo,
  })
  const items = feedOf({ moves: [...moves], withdrawals: [...withdrawals] }).savings.items
  return items.map(shown).sort((a, b) => a.nonce.localeCompare(b.nonce))
}

/** A device that made moves, and a fresh one on the same account and L1. */
async function devices() {
  const first = await moveWorld()
  const fresh = await moveWorld({ l1: first.l1, account: first.account })
  return { first, fresh }
}

describe("replayPass", () => {
  it("rebuilds a move whose release has not run as burned, from its burn", async () => {
    const { first, fresh } = await devices()
    const made = await first.service.add(SKY, 100n, "op-1")
    const burn = await first.withdrawals.get(made.withdrawalLocalId ?? "")

    expect((await fresh.replay()).written).toBe(1)
    const [move] = (await fresh.moves.view.get()).records
    expect(move).toMatchObject({
      phase: "burned",
      holdingId: SKY,
      direction: "in",
      amount: 100n,
      nonce: made.nonce,
      withdrawalId: burn?.withdrawalId,
      replayedFrom: burn?.l2TxHash,
      startTime: fresh.clock.now,
      escrow: made.rail === "skyEscrow" ? made.escrow : undefined,
    })
    expect((await fresh.replay()).written).toBe(0)
  })

  it("reads a burn the node had not indexed on a later pass, and keeps a move it omits", async () => {
    const { first, fresh } = await devices()
    const made = await first.service.add(SKY, 100n, "op-1")
    const hash = (await first.withdrawals.get(made.withdrawalLocalId ?? ""))?.l2TxHash ?? ""
    first.l1.unread.add(hash)
    expect(await fresh.replay()).toEqual({ written: 0, unread: true, skipped: 0 })

    first.l1.unread.delete(hash)
    expect(await fresh.replay()).toEqual({ written: 1, unread: false, skipped: 0 })
    const [move] = (await fresh.moves.view.get()).records
    first.l1.unread.add(hash)
    expect((await fresh.replay()).written).toBe(0)
    expect((await fresh.moves.view.get()).records).toEqual([move])
  })

  it("never saves a second record of a move this device saved during the pass's reads", async () => {
    let during: (() => Promise<unknown>) | undefined
    const world = await moveWorld({
      routes: (routes) => ({
        ...routes,
        read: async (holding) => {
          const run = during
          during = undefined
          await run?.()
          return routes.read(holding)
        },
      }),
    })
    during = () => world.service.add(SKY, 100n, "op-1")

    expect((await world.replay()).written).toBe(0)
    expect((await world.moves.view.get()).records).toHaveLength(1)
  })

  it("rebuilds a run move with its deposit and the vault's figure, which keeps it earning", async () => {
    const { first, fresh } = await devices()
    const made = await first.service.add(SKY, 100n, "op-1")
    const { made: deposit } = await runRoute(first, made, { assets: 97n, deposit: 90n })

    await fresh.replay()
    const [move] = (await fresh.moves.view.get()).records
    expect(move).toMatchObject({
      phase: "depositSeen",
      assets: 97n,
      l1: { depositTx: deposit.txHash },
    })
    await fresh.settle()
    const claimed = await fresh.read(move?.id ?? "")
    expect(claimed.phase).toBe("claimed")
    const ledger = holdingLedger([claimed], new Map())
    expect(ledger).toMatchObject({ basis: 97n, shares: 90n, excluded: [] })
    expect(holdingEarned(ledger, 99n, 90n, 18)).toBe(2n)
  })

  it("rebuilds a burn from the base as a move in, and one from the held bridge as a move out", async () => {
    const { first, fresh } = await devices()
    const into = await first.service.add(SKY, 100n, "op-in")
    await runRoute(first, into, { assets: 97n, deposit: 90n })
    await first.settle()
    const out = await first.service.withdraw(SKY, 90n, "op-out")

    expect((await fresh.replay()).written).toBe(2)
    const directions = (await fresh.moves.view.get()).records.map((m) => [m.nonce, m.direction])
    expect(directions).toEqual(
      expect.arrayContaining([
        [into.nonce, "in"],
        [out.nonce, "out"],
      ]),
    )
  })

  it("times a rebuilt move's release from L1, so its run is offered once the swap's wait passes", async () => {
    const { first, fresh } = await devices()
    const made = await first.service.add(SKY, 100n, "op-1")
    if (made.rail !== "skyEscrow") throw new Error("the move is not on the escrow rail")
    const released = await first.l1.release(
      SKY_HOLDING.base.portal as Address,
      (await first.withdrawalId(made))!,
    )
    await first.l1.fund(made.escrow.address, 97n)
    const block = await first.l1.client.getBlock({ blockNumber: released.blockNumber })
    const releasedAt = Number(block.timestamp) * 1000

    await fresh.replay()
    const [move] = (await fresh.moves.view.get()).records
    if (!move) throw new Error("the replay wrote no move")
    expect(move).toMatchObject({ phase: "burned", releasedAt, l1: { releaseTx: released.txHash } })
    const rails = { recoverable: true, runnable: true }
    const offer = (now: number) =>
      moveExitOffer({ state: selectMoveState(move, undefined, now), move }, rails, now)
    const stuck = releasedAt + SWAP_STUCK_THRESHOLD_MS
    expect(offer(stuck - 1)).toBeNull()
    expect(offer(stuck)).toBe("run")

    await fresh.service.run(move.id)
    await fresh.settle()
    expect((await fresh.read(move.id)).phase).toBe("released")
  })

  it("rebuilds a recovered move as recovered, to where its funds went", async () => {
    const { first, fresh } = await devices()
    const made = await first.service.add(SKY, 100n, "op-1")
    const withdrawalId = await first.withdrawalId(made)
    await first.l1.release(SKY_HOLDING.base.portal as Address, withdrawalId!)
    await first.l1.fund(first.l1.escrowFor(made.nonce), 97n)
    const txHash = await first.service.recover(made.id, TO)

    await fresh.replay()
    const [move] = (await fresh.moves.view.get()).records
    expect(move).toMatchObject({
      phase: "recovered",
      recoveredTo: TO,
      l1: { recoveryTx: txHash },
    })
  })

  it.each<[string, (account: MovesAccount) => MovesAccount]>([
    [
      "whose deposit opens to another account's secret",
      (account) => ({
        ...account,
        salts: () => ({ recipient: new Fr(9n), recovery: new Fr(8n) }),
      }),
    ],
    [
      "into a Sky escrow of a factory no route names",
      (account) => ({
        ...account,
        moveBurns: async (bridge, rail) => {
          const read = await account.moveBurns(bridge, rail)
          const burns = read.burns.map((burn) =>
            burn.rail === "skyEscrow"
              ? { ...burn, escrow: { ...burn.escrow, factory: OTHER_FACTORY } }
              : burn,
          )
          return { ...read, burns }
        },
      }),
    ],
  ])("skips a burn %s", async (_, scanned) => {
    const { first } = await devices()
    await first.service.add(SKY, 100n, "op-1")
    const other = await moveWorld({ l1: first.l1, account: scanned(first.account) })
    vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(await other.replay()).toMatchObject({ written: 0, skipped: 1 })
    expect((await other.moves.view.get()).records).toEqual([])
  })

  it("skips, and counts, a burn no holding's route owns", async () => {
    const { first } = await devices()
    await first.service.add(SKY, 100n, "op-1")
    const other = await moveWorld({
      l1: first.l1,
      account: first.account,
      routes: (routes) => ({ ...routes, owns: (_route, _burn): _burn is never => false }),
    })
    vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(await other.replay()).toMatchObject({ written: 0, skipped: 1 })
  })

  it("gives a fresh database the feed the device that moved shows, once every burn is indexed", async () => {
    const { first, fresh } = await devices()
    const into = await first.service.add(SKY, 100n, "op-in")
    await runRoute(first, into, { assets: 97n, deposit: 90n })
    await first.settle()
    const out = await first.service.withdraw(SKY, 40n, "op-out")
    await runRoute(first, out, { assets: 44n, deposit: 44n })
    await first.settle()
    const recovered = await first.service.add(SKY, 50n, "op-recovered")
    await first.l1.release(
      SKY_HOLDING.base.portal as Address,
      (await first.withdrawalId(recovered))!,
    )
    await first.l1.fund(first.l1.escrowFor(recovered.nonce), 47n)
    await first.service.recover(recovered.id, TO)
    const late = await first.service.add(SKY, 30n, "op-late")
    const lateHash = (await first.withdrawals.get(late.withdrawalLocalId ?? ""))?.l2TxHash ?? ""
    first.l1.unread.add(lateHash)
    const shown = await savingsFeed(first)
    expect(shown.map((m) => [m.direction, m.phase])).toEqual(
      expect.arrayContaining([
        ["in", "claimed"],
        ["out", "claimed"],
        ["in", "recovered"],
        ["in", "burned"],
      ]),
    )
    expect(shown).toHaveLength(4)

    expect(await fresh.replay()).toEqual({ written: 3, unread: true, skipped: 0 })
    await fresh.settle()
    expect(await savingsFeed(fresh)).toEqual(shown.filter((m) => m.nonce !== late.nonce))
    first.l1.unread.delete(lateHash)
    await fresh.replay()
    await fresh.settle()
    expect(await savingsFeed(fresh)).toEqual(shown)
  })
})
