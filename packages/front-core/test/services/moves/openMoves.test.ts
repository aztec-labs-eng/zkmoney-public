// @vitest-environment node
import { createPace } from "@obsidion/core/cadence"
import { describe, expect, it, vi } from "vitest"
import { getAddress, type Address } from "viem"
import { moveQuotes } from "../../../src/core/services/moves/moveQuotes"
import {
  openMoves,
  recoverableRails,
  runnableRails,
  selectMoveRecoverable,
} from "../../../src/core/services/moves/openMoves"
import type { MovesAccount } from "../../../src/core/services/moves/types"
import { MOVE_SCAN_SPAN } from "../../../src/engine/moveScanCursor"
import { RELAYER_MAX_PENDING_AGE_MS } from "../../../src/engine/moveState"
import type { MoveDirection, MoveRecord } from "../../../src/engine/moveTransition"
import { queries } from "../../../src/engine/query"
import { fixed } from "../../../src/engine/service"
import { memoryStore } from "../../../src/engine/store"
import { DAI_PORTAL, SKY_HOLDING, VAULT_HOLDING, VAULT_PORTAL } from "./fixtures"
import { moveWorld, runRoute, runVaultRoute, type MoveWorld, type WorldOptions } from "./moveWorld"

const SKY = SKY_HOLDING.id
const TO = getAddress(`0x${"0d".repeat(20)}`)
const ALL = { from: 0n, to: 10_000n }

const quotesOf = (world: MoveWorld) =>
  moveQuotes(
    queries({
      pace: createPace(),
      visible: memoryStore(true).readonly,
      now: () => world.clock.now,
    }),
    fixed("ports", world.ports),
  )

describe("openMoves", () => {
  it("refuses a holding no rail serves", async () => {
    const world = await moveWorld()
    await expect(quotesOf(world)("fea-none", "in", 100n).read()).rejects.toMatchObject({
      code: "holding.noRoute",
    })
    await expect(world.service.add("fea-none", 100n, "op-1")).rejects.toMatchObject({
      code: "holding.noRoute",
    })
  })

  it("refuses a move into a holding the wallet does not list, and still moves out of it", async () => {
    const world = await moveWorld({ listed: [] })
    await expect(world.service.add(SKY, 100n, "op-1")).rejects.toMatchObject({
      code: "move.exitOnly",
    })
    expect((await world.moves.view.get()).records).toEqual([])
    expect(await world.account.balance(SKY_HOLDING.base)).toBe(1_000n)
    const out = await world.service.withdraw(SKY, 100n, "op-2")
    expect(out).toMatchObject({ direction: "out", phase: "burned" })
  })

  it("refuses a move that would land less than its review showed, before sending", async () => {
    let drop = 0n
    const world = await moveWorld({
      routes: (routes) => ({
        ...routes,
        quote: async (route, direction, amount) => {
          const quote = await routes.quote(route, direction, amount)
          return { ...quote, conversionOut: quote.conversionOut - drop }
        },
      }),
    })
    const reviewed = await quotesOf(world)(SKY, "in", 100n).read()
    drop = 1n
    await expect(world.service.add(SKY, 100n, "op-1", reviewed)).rejects.toMatchObject({
      code: "move.quoteChanged",
    })
    expect((await world.moves.view.get()).records).toEqual([])
    expect(await world.account.balance(SKY_HOLDING.base)).toBe(1_000n)
  })

  it("ends a move cancelled before its burn proves dropped, and burns nothing", async () => {
    const world = await moveWorld()
    for (const cancelled of [
      world.service.add(SKY, 100n, "op-1", undefined, AbortSignal.abort()),
      world.service.withdraw(SKY, 100n, "op-2", undefined, AbortSignal.abort()),
    ])
      await expect(cancelled).rejects.toThrow()
    const { records } = await world.moves.view.get()
    expect(records.map((move) => move.phase)).toEqual(["dropped", "dropped"])
    expect(await world.account.balance(SKY_HOLDING.base)).toBe(1_000n)
  })

  it("recovers a move before its route runs, and refuses once it has", async () => {
    const world = await moveWorld()
    const rails = recoverableRails(world.ports.rails.get())
    const move = await world.service.add(SKY, 100n, "op-1")
    expect(selectMoveRecoverable(move, rails)).toBe(true)
    // Before its release there is nothing to recover, and after it nothing until the escrow is paid.
    await expect(world.service.recover(move.id, TO)).rejects.toMatchObject({
      code: "move.noRecovery",
    })
    await world.l1.release(SKY_HOLDING.base.portal as Address, (await world.withdrawalId(move))!)
    await expect(world.service.recover(move.id, TO)).rejects.toMatchObject({
      code: "move.escrowEmpty",
    })
    await world.l1.fund(world.l1.escrowFor(move.nonce), 97n)
    const txHash = await world.service.recover(move.id, TO)
    expect(await world.read(move.id)).toMatchObject({
      phase: "recovered",
      recoveredTo: TO,
      l1: { recoveryTx: txHash },
    })
    // The settle pass reads the same recovery from L1 and leaves the move as it is.
    await world.settle()
    expect((await world.read(move.id)).l1?.recoveryTx).toBe(txHash)

    const ran = await world.service.add(SKY, 100n, "op-2")
    await runRoute(world, ran, { assets: 97n, deposit: 90n })
    await world.settle()
    const claimed = await world.read(ran.id)
    expect(selectMoveRecoverable(claimed, rails)).toBe(false)
    await expect(world.service.recover(ran.id, TO)).rejects.toMatchObject({
      code: "move.noRecovery",
    })
  })

  it("refuses to recover a move whose escrow ran, though it holds the token again, and claims it", async () => {
    const world = await moveWorld()
    const move = await world.service.add(SKY, 100n, "op-1")
    // The escrow ran and no settle pass has seen it; then someone paid the escrow dust.
    await runRoute(world, move, { assets: 97n, deposit: 90n })
    await world.l1.fund(world.l1.escrowFor(move.nonce), 1n)

    await expect(world.service.recover(move.id, TO)).rejects.toMatchObject({
      code: "move.escrowRan",
    })
    expect(world.l1.fundsOf(world.l1.escrowFor(move.nonce))).toBe(1n)
    expect(await world.read(move.id)).toMatchObject({ phase: "depositSeen", assets: 97n })
    await world.settle()
    expect((await world.read(move.id)).phase).toBe("claimed")
    expect(await world.account.balance(SKY_HOLDING.held)).toBe(90n)
  })

  it("refuses a recovery before the move's release, though its escrow holds the token", async () => {
    const world = await moveWorld()
    const move = await world.service.add(SKY, 100n, "op-1")
    const escrow = world.l1.escrowFor(move.nonce)
    // Someone paid the escrow dust before the release funded it.
    await world.l1.fund(escrow, 1n)

    await expect(world.service.recover(move.id, TO)).rejects.toMatchObject({
      code: "move.noRecovery",
    })
    expect(world.l1.fundsOf(escrow)).toBe(1n)
    expect((await world.read(move.id)).phase).toBe("burned")
    // The release, run and deposit that follow are still the move's.
    await runRoute(world, move, { assets: 97n, deposit: 90n })
    await world.settle()
    expect((await world.read(move.id)).phase).toBe("claimed")
  })

  it("resolves a mined recovery whose check cannot read L1, and leaves the record to settle", async () => {
    const first = await moveWorld()
    let down = false
    const world = await moveWorld({
      l1: first.l1,
      account: {
        ...first.account,
        recovery: {
          ...first.account.recovery,
          send: async (call, to) => {
            const sent = await first.account.recovery.send(call, to)
            down = true
            return sent
          },
        },
      },
      routes: (routes) => ({
        ...routes,
        head: async () => {
          if (down) throw new Error("rpc down")
          return routes.head()
        },
      }),
    })
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const move = await world.service.add(SKY, 100n, "op-1")
    await world.l1.release(SKY_HOLDING.base.portal as Address, (await world.withdrawalId(move))!)
    await world.l1.fund(world.l1.escrowFor(move.nonce), 97n)

    const txHash = await world.service.recover(move.id, TO)
    expect(world.l1.fundsOf(world.l1.escrowFor(move.nonce))).toBe(0n)
    // Unchecked, the recovery is not recorded: the settle pass reads it from L1.
    expect((await world.read(move.id)).phase).toBe("burned")
    down = false
    await world.settle()
    expect(await world.read(move.id)).toMatchObject({
      phase: "recovered",
      recoveredTo: TO,
      l1: { recoveryTx: txHash },
    })
  })

  it("reads a run more than one search span past the move's cursor before it recovers", async () => {
    const world = await moveWorld()
    const move = await world.service.add(SKY, 100n, "op-1")
    for (let i = 0; i < 2 * Number(MOVE_SCAN_SPAN) + 5; i++) await world.l1.mine()
    await runRoute(world, move, { assets: 97n, deposit: 90n })
    await world.l1.fund(world.l1.escrowFor(move.nonce), 1n)

    await expect(world.service.recover(move.id, TO)).rejects.toMatchObject({
      code: "move.escrowRan",
    })
    expect((await world.read(move.id)).phase).toBe("depositSeen")
  })

  it("refuses a recovery of a move a settle pass saw run while the command read it", async () => {
    let pass = async () => {}
    const world = await moveWorld({
      routes: (routes) => ({
        ...routes,
        read: async (holding) => {
          await pass()
          return routes.read(holding)
        },
      }),
    })
    const move = await world.service.add(SKY, 100n, "op-1")
    const escrow = world.l1.escrowFor(move.nonce)
    const { made } = await runRoute(world, move, { assets: 97n, deposit: 90n })
    world.l1.inTransit.add(made.deposit.messageKey)
    await world.l1.fund(escrow, 1n)
    // The pass saves the run after the command has read the move as burned.
    pass = async () => {
      pass = async () => {}
      await world.settle()
    }

    await expect(world.service.recover(move.id, TO)).rejects.toMatchObject({
      code: "move.escrowRan",
    })
    expect(world.l1.fundsOf(escrow)).toBe(1n)
    expect((await world.read(move.id)).phase).toBe("depositSeen")
  })

  it("refuses a recovery its escrow's run overtook while it was signed, and claims the move", async () => {
    const first = await moveWorld()
    let overtake = async () => {}
    const world = await moveWorld({
      l1: first.l1,
      account: {
        ...first.account,
        recovery: {
          ...first.account.recovery,
          send: async (call, to) => {
            await overtake()
            return first.account.recovery.send(call, to)
          },
        },
      },
    })
    const move = await world.service.add(SKY, 100n, "op-1")
    const escrow = world.l1.escrowFor(move.nonce)
    await world.l1.release(SKY_HOLDING.base.portal as Address, (await world.withdrawalId(move))!)
    await world.l1.fund(escrow, 97n)
    // A relayer runs the escrow before the recovery is mined, and the escrow is paid dust.
    overtake = async () => {
      await runRoute(world, move, { assets: 97n, deposit: 90n })
      await world.l1.fund(escrow, 1n)
    }

    await expect(world.service.recover(move.id, TO)).rejects.toMatchObject({
      code: "move.escrowRan",
    })
    expect(await world.read(move.id)).toMatchObject({ phase: "depositSeen", assets: 97n })
    await world.settle()
    expect((await world.read(move.id)).phase).toBe("claimed")
  })

  it("runs a stalled move's escrow with the account's keys, and refuses once it ran", async () => {
    const world = await moveWorld()
    expect(runnableRails(world.ports.rails.get())).toEqual(new Set(["skyEscrow"]))
    const move = await world.service.add(SKY, 100n, "op-1")
    if (move.rail !== "skyEscrow") throw new Error("the move is not on the escrow rail")
    await world.l1.release(SKY_HOLDING.base.portal as Address, (await world.withdrawalId(move))!)
    await world.l1.fund(move.escrow.address, 97n)
    await world.service.run(move.id)
    expect(world.l1.fundsOf(move.escrow.address)).toBe(0n)
    await world.settle()
    expect((await world.read(move.id)).phase).toBe("released")
    await expect(world.service.run(move.id)).rejects.toMatchObject({ code: "move.escrowRan" })
  })

  it("hands the caller's watch of an L1 send to the account that sends it", async () => {
    const world = await moveWorld()
    type Watch = (sent: "run" | "recovery") => void
    const { account } = world.ports
    const watched: MovesAccount<Watch> = {
      ...account,
      recovery: {
        ...account.recovery,
        send: (call, to, watch) => (watch?.("recovery"), account.recovery.send(call, to)),
      },
      runRoute: (call, target, watch) => (watch?.("run"), account.runRoute(call, target)),
    }
    const ports = fixed("ports", { ...world.ports, account: watched })
    const service = await openMoves({ ...world.deps, ports }).ready()
    const seen: string[] = []
    const fund = async (operationId: string) => {
      const move = await world.service.add(SKY, 100n, operationId)
      if (move.rail !== "skyEscrow") throw new Error("the move is not on the escrow rail")
      await world.l1.release(SKY_HOLDING.base.portal as Address, (await world.withdrawalId(move))!)
      await world.l1.fund(move.escrow.address, 97n)
      return move
    }
    await service.run((await fund("op-1")).id, (sent) => void seen.push(sent))
    await service.recover((await fund("op-2")).id, TO, (sent) => void seen.push(sent))
    expect(seen).toEqual(["run", "recovery"])
  })

  describe("a vault move's recovery", () => {
    const VAULT = VAULT_HOLDING.id
    const AMOUNT = 1_000n * 10n ** 18n
    const vaultWorld = (opts: WorldOptions = {}) =>
      moveWorld({
        rail: "executor",
        balances: { [DAI_PORTAL]: AMOUNT, [VAULT_PORTAL]: AMOUNT },
        ...opts,
      })
    const moveOn = (world: MoveWorld, direction: MoveDirection) =>
      direction === "in"
        ? world.service.add(VAULT, AMOUNT, "op-1")
        : world.service.withdraw(VAULT, AMOUNT, "op-1")
    const burnOf = async (world: MoveWorld, move: MoveRecord) =>
      (await world.withdrawals.get(move.withdrawalLocalId ?? ""))?.l2TxHash ?? ""
    const ROUTE = { assets: 900n, deposit: 900n }

    it.each(["in", "out"] as const)(
      "recovers a move %s whose route never ran, once, and no release pays it again",
      async (direction) => {
        const world = await vaultWorld()
        const move = await moveOn(world, direction)
        expect(selectMoveRecoverable(move, recoverableRails(world.ports.rails.get()))).toBe(true)
        world.clock.now += RELAYER_MAX_PENDING_AGE_MS

        const txHash = await world.service.recover(move.id, TO)
        const recovered = await world.read(move.id)
        expect(recovered).toMatchObject({ phase: "recovered", recoveredTo: TO })
        expect(recovered.l1?.recoveryTx).toBe(txHash)
        const withdrawalId = await world.withdrawalId(move)
        expect(world.l1.executorRecoveries).toMatchObject([
          { txHash, withdrawalId, recipient: TO, amount: AMOUNT },
        ])

        await expect(world.service.recover(move.id, TO)).rejects.toMatchObject({
          code: "move.noRecovery",
        })
        await expect(runVaultRoute(world, move, ROUTE)).rejects.toThrow()
        await world.settle()
        expect((await world.read(move.id)).phase).toBe("recovered")
        expect(world.l1.executorRecoveries).toHaveLength(1)
        expect(world.l1.depositIn(VAULT_PORTAL, move.recipientCommitment, ALL)).toBeUndefined()
      },
    )

    it("refuses a recovery before the relayer is given up on or the burn's epoch is proven", async () => {
      const world = await vaultWorld()
      const move = await moveOn(world, "in")
      const burn = await burnOf(world, move)
      const refused = { code: "move.noRecovery" }

      world.clock.now += RELAYER_MAX_PENDING_AGE_MS - 1
      await expect(world.service.recover(move.id, TO)).rejects.toMatchObject(refused)
      world.clock.now += 1
      world.l1.unproven.add(burn)
      await expect(world.service.recover(move.id, TO)).rejects.toMatchObject(refused)
      expect(world.l1.executorRecoveries).toEqual([])
      expect((await world.read(move.id)).phase).toBe("burned")

      world.l1.unproven.delete(burn)
      await world.service.recover(move.id, TO)
      expect((await world.read(move.id)).phase).toBe("recovered")
    })

    it("refuses a recovery once the relayer released the move, which settles as it ran", async () => {
      const world = await vaultWorld()
      const move = await moveOn(world, "in")
      world.clock.now += RELAYER_MAX_PENDING_AGE_MS
      await runVaultRoute(world, move, ROUTE)

      await expect(world.service.recover(move.id, TO)).rejects.toMatchObject({
        code: "move.noRecovery",
      })
      expect(await world.read(move.id)).toMatchObject({ phase: "depositSeen", assets: 900n })
      expect(world.l1.executorRecoveries).toEqual([])
    })

    it("refuses a recovery the relayer's release overtook while it was signed, and settles the move as released", async () => {
      const first = await vaultWorld()
      let overtake = async () => {}
      const world = await vaultWorld({
        l1: first.l1,
        account: {
          ...first.account,
          recovery: {
            ...first.account.recovery,
            send: async (call, to) => {
              await overtake()
              return first.account.recovery.send(call, to)
            },
          },
        },
      })
      const move = await moveOn(world, "in")
      world.clock.now += RELAYER_MAX_PENDING_AGE_MS
      overtake = async () => void (await runVaultRoute(world, move, ROUTE))

      await expect(world.service.recover(move.id, TO)).rejects.toMatchObject({
        code: "move.noRecovery",
      })
      expect(await world.read(move.id)).toMatchObject({ phase: "depositSeen", assets: 900n })
      expect(world.l1.executorRecoveries).toEqual([])
    })

    it("settles a released vault move in one pass, from burned to its deposit", async () => {
      const world = await vaultWorld()
      const move = await moveOn(world, "in")
      const phases: string[] = []
      const unsubscribe = world.moves.view.subscribe(() =>
        world.moves.view.get().records.forEach((r) => phases.push(r.phase)),
      )
      await runVaultRoute(world, move, ROUTE)
      await world.settle()
      unsubscribe()
      expect(await world.read(move.id)).toMatchObject({ phase: "depositSeen", assets: 900n })
      expect(phases).not.toContain("released")
    })

    it("reads a recovery another device made as the move's end", async () => {
      const world = await vaultWorld()
      const move = await moveOn(world, "out")
      world.clock.now += RELAYER_MAX_PENDING_AGE_MS
      const txHash = await world.service.recover(move.id, TO)

      const other = await vaultWorld({ l1: world.l1, account: world.account })
      await other.replay()
      await other.settle()
      const [replayed] = (await other.moves.view.get()).records
      expect(replayed).toMatchObject({ phase: "recovered", recoveredTo: TO })
      expect(replayed?.l1?.recoveryTx).toBe(txHash)
    })
  })
})
