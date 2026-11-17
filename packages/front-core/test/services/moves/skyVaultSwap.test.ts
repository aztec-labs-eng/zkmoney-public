// @vitest-environment node
import { createPace } from "@obsidion/core/cadence"
import { describe, expect, it } from "vitest"
import { getAddress, type Address } from "viem"
import { vaultSwapQuotes } from "../../../src/core/services/moves/moveQuotes"
import {
  recoverableRails,
  selectMoveRecoverable,
  vaultSwapTargets,
} from "../../../src/core/services/moves/openMoves"
import { RELAYER_MAX_PENDING_AGE_MS } from "../../../src/engine/moveState"
import { queries } from "../../../src/engine/query"
import { fixed } from "../../../src/engine/service"
import { memoryStore } from "../../../src/engine/store"
import type { MoveRecord } from "../../../src/engine/moveTransition"
import {
  DAI_PORTAL,
  SKY_HOLDING,
  SUSDS,
  SUSDS_PORTAL,
  VAULT,
  VAULT_HOLDING,
  VAULT_PORTAL,
} from "./fixtures"
import { moveWorld, type MoveWorld, type WorldOptions } from "./moveWorld"

const SKY = SKY_HOLDING.id
const V = VAULT_HOLDING.id
const AMOUNT = 1_000n * 10n ** 18n
const TO = getAddress(`0x${"0d".repeat(20)}`)
const RUN = { redeemed: 1_040n, took: 1_040n, deposited: 990n }

/** Sky's escrow rail and the executor's, which swaps Sky's holding to and from `VAULT`. */
const skyWorld = (opts: WorldOptions = {}) =>
  moveWorld({
    rail: "both",
    balances: { [DAI_PORTAL]: 1_000n, [SUSDS_PORTAL]: AMOUNT, [VAULT_PORTAL]: AMOUNT },
    ...opts,
  })

const ENDS: Record<string, { vault: Address; portal: Address }> = {
  [SKY]: { vault: SUSDS, portal: SUSDS_PORTAL },
  [V]: { vault: VAULT, portal: VAULT_PORTAL },
}

/** What the relayer does for a swap: one tx from its source's release to its portal deposit. */
async function runVaultSwap(world: MoveWorld, move: MoveRecord) {
  const withdrawalId = await world.withdrawalId(move)
  const [from, to] = [ENDS[move.holdingId], ENDS[move.intoHoldingId ?? ""]]
  if (!withdrawalId || !from || !to) throw new Error(`move ${move.id} is no swap to run`)
  return world.l1.executorVaultSwap(move.recipientCommitment, {
    ...RUN,
    release: { portal: from.portal, withdrawalId },
    from: from.vault,
    to,
  })
}

describe("a swap between Sky's savings and a vault", () => {
  it("offers and quotes Sky a vault and the vault Sky, as the swaps it accepts", async () => {
    const world = await skyWorld()
    expect(vaultSwapTargets(world.ports.rails.get())).toEqual(
      new Map([
        [V, [SKY]],
        [SKY, [V]],
      ]),
    )
    const quotes = vaultSwapQuotes(
      queries({ pace: createPace(), visible: memoryStore(true).readonly, now: () => 0 }),
      fixed("ports", world.ports),
    )
    for (const [from, into] of [
      [SKY, V],
      [V, SKY],
    ] as const) {
      const quote = await quotes(from, into, AMOUNT).read()
      expect(await world.service.vaultSwap(from, into, AMOUNT, `op-${from}`, quote)).toMatchObject({
        quote,
        rail: "executor",
      })
    }
  })

  it("runs on the executor both ways, while Sky's moves in and out stay on its escrows", async () => {
    const world = await skyWorld()
    const out = await world.service.vaultSwap(SKY, V, AMOUNT, "op-1")
    expect(out).toMatchObject({
      holdingId: SKY,
      intoHoldingId: V,
      direction: "out",
      rail: "executor",
      destination: getAddress(VAULT_PORTAL),
      phase: "burned",
    })
    const back = await world.service.vaultSwap(V, SKY, AMOUNT, "op-2")
    expect(back).toMatchObject({
      holdingId: V,
      intoHoldingId: SKY,
      rail: "executor",
      destination: getAddress(SUSDS_PORTAL),
    })
    expect(await world.account.balance(SKY_HOLDING.held)).toBe(0n)
    expect(await world.account.balance(VAULT_HOLDING.held)).toBe(0n)

    await runVaultSwap(world, out)
    await runVaultSwap(world, back)
    await world.settle()
    for (const move of [out, back])
      expect(await world.read(move.id)).toMatchObject({ phase: "claimed", assets: RUN.took })
    expect(await world.account.balance(SKY_HOLDING.held)).toBe(RUN.deposited)
    expect(await world.account.balance(VAULT_HOLDING.held)).toBe(RUN.deposited)

    expect(await world.service.add(SKY, 100n, "op-3")).toMatchObject({ rail: "skyEscrow" })
    expect(await world.service.withdraw(SKY, 90n, "op-4")).toMatchObject({ rail: "skyEscrow" })
  })

  it("recovers a stuck swap out of Sky as sUSDS, on the executor", async () => {
    const world = await skyWorld()
    const move = await world.service.vaultSwap(SKY, V, AMOUNT, "op-1")
    expect(selectMoveRecoverable(move, recoverableRails(world.ports.rails.get()))).toBe(true)
    world.clock.now += RELAYER_MAX_PENDING_AGE_MS

    const txHash = await world.service.recover(move.id, TO)
    expect(await world.read(move.id)).toMatchObject({ phase: "recovered", recoveredTo: TO })
    expect(world.l1.executorRecoveries).toMatchObject([
      { txHash, withdrawalId: await world.withdrawalId(move), recipient: TO, amount: AMOUNT },
    ])
  })

  it("tells a fresh device's swaps out of Sky from its escrow moves out, by the rail that reads each burn", async () => {
    const world = await skyWorld()
    const escrowOut = await world.service.withdraw(SKY, 100n, "op-1")
    const out = await world.service.vaultSwap(SKY, V, AMOUNT / 2n, "op-2")
    const back = await world.service.vaultSwap(V, SKY, AMOUNT, "op-3")
    await runVaultSwap(world, out)

    const other = await skyWorld({ l1: world.l1, account: world.account })
    expect(await other.replay()).toMatchObject({ written: 3, skipped: 0 })
    await other.settle()
    const replayed = new Map((await other.moves.view.get()).records.map((m) => [m.nonce, m]))
    expect(replayed.get(escrowOut.nonce)).toMatchObject({
      rail: "skyEscrow",
      holdingId: SKY,
      direction: "out",
    })
    expect(replayed.get(escrowOut.nonce)?.intoHoldingId).toBeUndefined()
    expect(replayed.get(out.nonce)).toMatchObject({
      rail: "executor",
      holdingId: SKY,
      intoHoldingId: V,
      phase: "claimed",
    })
    expect(replayed.get(back.nonce)).toMatchObject({
      rail: "executor",
      holdingId: V,
      intoHoldingId: SKY,
      phase: "burned",
    })
  })
})
