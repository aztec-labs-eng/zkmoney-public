// @vitest-environment node
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { VaultMoveBurn } from "@obsidion/sdk"
import { getAddress, type Hex } from "viem"
import { describe, expect, it } from "vitest"
import { executorMoveBurns, executorRoutes } from "../../../src/core/services/moves/executorRoutes"
import type { MoveDirection } from "../../../src/engine/moveTransition"
import {
  DAI,
  FEED,
  fakeL1,
  LIMITS,
  RECOVERY_KEYS,
  releaseArgsOf,
  VAULT,
  VAULT_HOLDING,
} from "./fixtures"
import type { FakeL1 } from "./fixtures"
import { moveRoutesContract, NONCE } from "./moveRoutesContract"

const AMOUNT = 1_000n * 10n ** 18n
const OTHER_COMMITMENT = `0x00${"6d".repeat(31)}` as Hex
const WITHDRAWAL = `0x${"5a".repeat(32)}` as Hex
const OTHER_WITHDRAWAL = `0x${"6b".repeat(32)}` as Hex
const RECIPIENT = getAddress(`0x${"0d".repeat(20)}`)

const routesOver = (l1: FakeL1) => executorRoutes({ l1: l1.client, eth: { feed: FEED } })

describe("executorRoutes", () => {
  moveRoutesContract({
    l1: () => fakeL1(),
    routes: routesOver,
    holding: VAULT_HOLDING,
    amount: AMOUNT,
    token: { address: DAI, symbol: "DAI", decimals: 18 },
    limits: LIMITS,
    keys: RECOVERY_KEYS,
    escrowTip: () => undefined,
    recoveredToken: () => {
      throw new Error("the executor rail recovers no escrow")
    },
  })

  /** A move of `direction` built on a fresh fake, and its record's fields `outcome` reads. */
  const moveOn = async (direction: MoveDirection) => {
    const l1 = fakeL1()
    const routes = routesOver(l1)
    const route = await routes.read(VAULT_HOLDING)
    const from = AztecAddress.fromBigIntUnsafe(1n)
    const recipientCommitment = await routes.commitment(new Fr(1n), from)
    const quote = await routes.quote(route, direction, AMOUNT)
    const args = { direction, amount: AMOUNT, from, nonce: NONCE, recipientCommitment }
    const built = routes.build(route, { ...args, recovery: RECOVERY_KEYS }, quote)
    const move = { ...built, direction, recipientCommitment, withdrawalId: WITHDRAWAL }
    return { l1, routes, route, move }
  }

  it.each(["in", "out"] as const)(
    "reads a move %s's run from the vault's last event before its deposit, in that tx only",
    async (direction) => {
      const { l1, routes, route, move } = await moveOn(direction)
      const other = await l1.executorRun(direction, OTHER_COMMITMENT, {
        assets: [3n],
        deposited: 3n,
      })
      const atOther = { from: other.blockNumber, to: other.blockNumber }
      expect(await routes.outcome(route, move, atOther)).toBeUndefined()
      const ran = await l1.executorRun(direction, move.recipientCommitment, {
        assets: [5n, 7n],
        deposited: 9n,
        trailing: [11n],
      })
      const at = { from: ran.blockNumber, to: ran.blockNumber }
      expect(await routes.outcome(route, move, at)).toEqual({ kind: "ran", assets: 7n })
      const before = { from: 0n, to: ran.blockNumber - 1n }
      expect(await routes.outcome(route, move, before)).toBeUndefined()
    },
  )

  it.each([
    ["in", DAI],
    ["out", VAULT],
  ] as const)(
    "recovers a move %s's withdrawal to an address in its source token, once, which its outcome reads",
    async (direction, token) => {
      const { l1, routes, route, move } = await moveOn(direction)
      if (!routes.recover) throw new Error("the executor rail recovers")
      const record = {
        ...move,
        id: "move-1",
        holdingId: VAULT_HOLDING.id,
        amount: AMOUNT,
        nonce: NONCE,
        scanFrom: 0n,
        phase: "burned" as const,
        startTime: 0,
      }
      const recover = (withdrawalId: Hex) =>
        routes.recover!(route, record, RECOVERY_KEYS, RECIPIENT, async (executor, tipRecipient) =>
          releaseArgsOf({ executor, amount: AMOUNT, withdrawalId, tipRecipient }),
        )
      const other = await l1.send(await recover(OTHER_WITHDRAWAL))
      const atOther = { from: other.blockNumber, to: other.blockNumber }
      expect(await routes.outcome(route, move, atOther)).toBeUndefined()

      const call = await recover(WITHDRAWAL)
      const sent = await l1.send(call)
      const at = { from: sent.blockNumber, to: sent.blockNumber }
      expect(await routes.outcome(route, move, at)).toEqual({
        kind: "recovered",
        txHash: sent.txHash,
        to: RECIPIENT,
        token,
        blockNumber: sent.blockNumber,
      })
      expect(await routes.withdrawalSpent(route, direction, WITHDRAWAL)).toBe(true)
      await expect(l1.send(call)).rejects.toThrow()
      const before = { from: 0n, to: sent.blockNumber - 1n }
      expect(await routes.outcome(route, move, before)).toBeUndefined()
    },
  )

  it("refuses as unread a deposit to the move's commitment that no vault event precedes", async () => {
    const { l1, routes, route, move } = await moveOn("in")
    const made = await l1.deposit(move.destination, move.recipientCommitment, 9n)
    const at = { from: made.blockNumber, to: made.blockNumber }
    await expect(routes.outcome(route, move, at)).rejects.toMatchObject({
      code: "move.routeUnread",
    })
  })
})

describe("executorMoveBurns", () => {
  const DESTINATION = getAddress(`0x${"d5".repeat(20)}`)
  const burn = (n: number): VaultMoveBurn => ({
    txHash: `0x${n.toString(16).padStart(64, "0")}`,
    blockNumber: n,
    withdrawalId: `0x${"1d".repeat(32)}`,
    amount: 40n,
    nonce: NONCE,
    destination: DESTINATION,
    recipientCommitment: OTHER_COMMITMENT,
  })
  const timestampMs = async (block: number) => (block === 9 ? undefined : block * 1_000)

  it("reads each burn as the engine's executor move, stamped with its L2 block's time", async () => {
    const read = await executorMoveBurns({ burns: [burn(3)], unread: ["0xab"] }, timestampMs)
    expect(read).toEqual({
      burns: [
        {
          rail: "executor",
          destination: DESTINATION,
          txHash: burn(3).txHash,
          timestampMs: 3_000,
          withdrawalId: burn(3).withdrawalId,
          amount: 40n,
          nonce: NONCE,
          recipientCommitment: OTHER_COMMITMENT,
        },
      ],
      unread: true,
    })
    expect((await executorMoveBurns({ burns: [], unread: [] }, timestampMs)).unread).toBe(false)
  })

  it("fails the scan when a burn's block time does not read", async () => {
    await expect(
      executorMoveBurns({ burns: [burn(3), burn(9)], unread: [] }, timestampMs),
    ).rejects.toMatchObject({ code: "scan.incomplete" })
  })
})
