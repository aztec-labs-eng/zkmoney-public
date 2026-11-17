// @vitest-environment node
import { createPace } from "@obsidion/core/cadence"
import { describe, expect, it } from "vitest"
import { getAddress } from "viem"
import { vaultSwapQuotes } from "../../../src/core/services/moves/moveQuotes"
import {
  recoverableRails,
  selectMoveRecoverable,
  vaultSwapTargets,
} from "../../../src/core/services/moves/openMoves"
import { queries } from "../../../src/engine/query"
import { fixed } from "../../../src/engine/service"
import { memoryStore } from "../../../src/engine/store"
import { RELAYER_MAX_PENDING_AGE_MS } from "../../../src/engine/moveState"
import { MOVE_SCAN_MARGIN } from "../../../src/engine/moveScanCursor"
import type { MoveRecord } from "../../../src/engine/moveTransition"
import type { BoundRail } from "../../../src/core/services/moves/types"
import {
  DAI_PORTAL,
  SKY_HOLDING,
  VAULT_B_HOLDING,
  VAULT_B_PORTAL,
  VAULT_HOLDING,
  VAULT_PORTAL,
} from "./fixtures"
import { moveWorld, type MoveWorld, type WorldOptions } from "./moveWorld"

const A = VAULT_HOLDING.id
const B = VAULT_B_HOLDING.id
const AMOUNT = 1_000n * 10n ** 18n
const TO = getAddress(`0x${"0d".repeat(20)}`)
const ALL = { from: 0n, to: 10_000n }
const RUN = { redeemed: 1_040n, took: 1_040n, deposited: 990n }

const vaultSwapWorld = (opts: WorldOptions = {}) =>
  moveWorld({
    rail: "executor",
    vaults: [VAULT_HOLDING, VAULT_B_HOLDING],
    balances: { [DAI_PORTAL]: 0n, [VAULT_PORTAL]: AMOUNT },
    ...opts,
  })

/** What the relayer does for a swap: one tx from A's release to B's portal deposit. */
async function runVaultSwap(world: MoveWorld, move: MoveRecord) {
  const withdrawalId = await world.withdrawalId(move)
  if (!withdrawalId) throw new Error(`move ${move.id} has no withdrawal id`)
  return world.l1.executorVaultSwap(move.recipientCommitment, {
    ...RUN,
    release: { portal: VAULT_PORTAL, withdrawalId },
  })
}

const quotesOf = (world: MoveWorld) =>
  vaultSwapQuotes(
    queries({
      pace: createPace(),
      visible: memoryStore(true).readonly,
      now: () => world.clock.now,
    }),
    fixed("ports", world.ports),
  )

describe("a swap between two vaults", () => {
  it("burns A's shares once and claims B's, its record a move out of A into B", async () => {
    const world = await vaultSwapWorld()
    const move = await world.service.vaultSwap(A, B, AMOUNT, "op-1")
    expect(move).toMatchObject({
      holdingId: A,
      intoHoldingId: B,
      direction: "out",
      rail: "executor",
      destination: VAULT_B_PORTAL,
      amount: AMOUNT,
      phase: "burned",
    })
    expect(move.quote?.out).toEqual({
      minOut: expect.any(BigInt),
      conversionMinOut: expect.any(BigInt),
    })
    expect(await world.account.balance(VAULT_HOLDING.held)).toBe(0n)

    await runVaultSwap(world, move)
    await world.settle()
    expect(await world.read(move.id)).toMatchObject({
      phase: "claimed",
      assets: RUN.took,
      deposit: { amount: RUN.deposited },
    })
    expect(await world.account.balance(VAULT_B_HOLDING.held)).toBe(RUN.deposited)
    expect(await world.account.balance(VAULT_HOLDING.base)).toBe(0n)
  })

  it("claims a swap the relayer ran while the deployment did not serve B, once it serves B again", async () => {
    const world = await vaultSwapWorld()
    const move = await world.service.vaultSwap(A, B, AMOUNT, "op-1")
    const served = world.ports.rails.get()
    const withoutB = await moveWorld({ l1: world.l1, account: world.account, rail: "executor" })
    world.ports.rails = { ...world.ports.rails, get: () => withoutB.ports.rails.get() }
    await runVaultSwap(world, move)
    for (let i = 0n; i <= MOVE_SCAN_MARGIN; i++) await world.l1.mine()
    await world.settle()
    const held = await world.read(move.id)
    expect(held.phase).toBe("burned")
    expect(held.scannedTo).toBe(move.scannedTo)

    world.ports.rails = { ...world.ports.rails, get: () => served }
    await world.settle()
    expect(await world.read(move.id)).toMatchObject({
      phase: "claimed",
      deposit: { amount: RUN.deposited },
    })
  })

  it("recovers a stuck swap as A's shares, and nothing lands in B", async () => {
    const world = await vaultSwapWorld()
    const move = await world.service.vaultSwap(A, B, AMOUNT, "op-1")
    expect(selectMoveRecoverable(move, recoverableRails(world.ports.rails.get()))).toBe(true)
    await expect(world.service.recover(move.id, TO)).rejects.toMatchObject({
      code: "move.noRecovery",
    })
    world.clock.now += RELAYER_MAX_PENDING_AGE_MS

    const txHash = await world.service.recover(move.id, TO)
    expect(await world.read(move.id)).toMatchObject({ phase: "recovered", recoveredTo: TO })
    expect(world.l1.executorRecoveries).toMatchObject([
      { txHash, withdrawalId: await world.withdrawalId(move), recipient: TO, amount: AMOUNT },
    ])
    await world.settle()
    expect((await world.read(move.id)).phase).toBe("recovered")
    expect(world.l1.depositIn(VAULT_B_PORTAL, move.recipientCommitment, ALL)).toBeUndefined()
  })

  it("recovers a stuck swap as A's shares once the deployment no longer serves B", async () => {
    const world = await vaultSwapWorld()
    const move = await world.service.vaultSwap(A, B, AMOUNT, "op-1")
    const withoutB = await moveWorld({ l1: world.l1, account: world.account, rail: "executor" })
    world.ports.rails = { ...world.ports.rails, get: () => withoutB.ports.rails.get() }
    await world.settle()
    world.clock.now += RELAYER_MAX_PENDING_AGE_MS

    const txHash = await world.service.recover(move.id, TO)
    expect(await world.read(move.id)).toMatchObject({ phase: "recovered", recoveredTo: TO })
    expect(world.l1.executorRecoveries).toMatchObject([{ txHash, recipient: TO, amount: AMOUNT }])
  })

  it("recovers a stuck swap as A's shares when B's route cannot be read", async () => {
    const world = await vaultSwapWorld()
    const move = await world.service.vaultSwap(A, B, AMOUNT, "op-1")
    const rails = world.ports.rails.get().map(
      (bound): BoundRail =>
        (use) =>
          bound((rail) =>
            use({
              ...rail,
              routes: {
                ...rail.routes,
                read: (holding) =>
                  holding.id === B
                    ? Promise.reject(new Error("B unread"))
                    : rail.routes.read(holding),
              },
            }),
          ),
    )
    world.ports.rails = { ...world.ports.rails, get: () => rails }
    world.clock.now += RELAYER_MAX_PENDING_AGE_MS

    const txHash = await world.service.recover(move.id, TO)
    expect(await world.read(move.id)).toMatchObject({ phase: "recovered", recoveredTo: TO })
    expect(world.l1.executorRecoveries).toMatchObject([{ txHash, recipient: TO, amount: AMOUNT }])
  })

  it("finds a swap's burn on a fresh device, as a move out of A into B, and claims B's shares", async () => {
    const world = await vaultSwapWorld()
    const move = await world.service.vaultSwap(A, B, AMOUNT, "op-1")
    await runVaultSwap(world, move)

    const other = await vaultSwapWorld({ l1: world.l1, account: world.account })
    expect(await other.replay()).toMatchObject({ written: 1, skipped: 0 })
    await other.settle()
    const [replayed] = (await other.moves.view.get()).records
    expect(replayed).toMatchObject({
      holdingId: A,
      intoHoldingId: B,
      direction: "out",
      destination: VAULT_B_PORTAL,
      nonce: move.nonce,
      phase: "claimed",
      assets: RUN.took,
    })
    expect(await world.account.balance(VAULT_B_HOLDING.held)).toBe(RUN.deposited)
  })

  it("offers a stuck swap a fresh device finds for recovery, and recovers A's shares", async () => {
    const world = await vaultSwapWorld()
    const move = await world.service.vaultSwap(A, B, AMOUNT, "op-1")
    const other = await vaultSwapWorld({ l1: world.l1, account: world.account })
    await other.replay()
    const [replayed] = (await other.moves.view.get()).records
    if (!replayed) throw new Error("no replayed swap")
    expect(replayed).toMatchObject({ intoHoldingId: B, phase: "burned" })
    expect(selectMoveRecoverable(replayed, recoverableRails(other.ports.rails.get()))).toBe(true)

    other.clock.now += RELAYER_MAX_PENDING_AGE_MS
    const txHash = await other.service.recover(replayed.id, TO)
    expect(await other.read(replayed.id)).toMatchObject({ phase: "recovered", recoveredTo: TO })
    expect(other.l1.executorRecoveries).toMatchObject([
      { txHash, withdrawalId: await world.withdrawalId(move), recipient: TO, amount: AMOUNT },
    ])
  })

  it("offers and quotes the swaps it accepts: into a listed vault on the same rail", async () => {
    const world = await vaultSwapWorld({ listed: [B] })
    expect(vaultSwapTargets(world.ports.rails.get())).toEqual(
      new Map([
        [A, [B]],
        [B, []],
      ]),
    )
    const quote = await quotesOf(world)(A, B, AMOUNT).read()
    const move = await world.service.vaultSwap(A, B, AMOUNT, "op-1", quote)
    expect(move.quote).toEqual(quote)
    await expect(world.service.vaultSwap(B, A, 1n, "op-2")).rejects.toMatchObject({
      code: "move.exitOnly",
    })
  })

  it("refuses a swap into a holding the wallet does not list, or no rail serves", async () => {
    const world = await vaultSwapWorld({ listed: [A] })
    await expect(world.service.vaultSwap(A, B, AMOUNT, "op-1")).rejects.toMatchObject({
      code: "move.exitOnly",
    })
    await expect(world.service.vaultSwap(A, "fea-none", AMOUNT, "op-1")).rejects.toMatchObject({
      code: "holding.noRoute",
    })
    await expect(world.service.vaultSwap(A, A, AMOUNT, "op-1")).rejects.toMatchObject({
      code: "move.noVaultSwap",
    })
    expect(await world.moves.open()).toEqual([])
  })

  it("refuses a swap between holdings on two rails", async () => {
    const vaults = await vaultSwapWorld()
    const world = await moveWorld({ l1: vaults.l1, account: vaults.account })
    const rails = [...world.ports.rails.get(), ...vaults.ports.rails.get()]
    world.ports.rails = { ...world.ports.rails, get: () => rails }
    expect(vaultSwapTargets(rails).has(SKY_HOLDING.id)).toBe(false)
    await expect(quotesOf(world)(SKY_HOLDING.id, A, 10n).read()).rejects.toMatchObject({
      code: "move.noVaultSwap",
    })
    await expect(world.service.vaultSwap(SKY_HOLDING.id, A, 10n, "op-1")).rejects.toMatchObject({
      code: "move.noVaultSwap",
    })
    expect(await world.moves.open()).toEqual([])
  })
})
