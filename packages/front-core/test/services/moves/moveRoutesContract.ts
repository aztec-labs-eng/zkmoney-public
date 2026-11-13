// The cases every `MoveRoutes` implementation passes.
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { decodeWithdrawalMemo } from "@obsidion/sdk"
import { isAddressEqual, type Address, type Hash, type Hex } from "viem"
import { expect, it } from "vitest"
import type {
  MoveDeposit,
  MoveDirection,
  MoveLimits,
  MoveQuote,
  MoveRecord,
} from "../../../src/engine/moveTransition"
import type {
  BuiltBurn,
  L1Call,
  MoveArgs,
  MoveBurn,
  MoveRoute,
  MoveRoutes,
  RailMove,
  RecoveryKeys,
  RouteHolding,
} from "../../../src/core/services/moves/types"

export interface L1Tx {
  txHash: Hash
  blockNumber: bigint
}

/** What a case makes happen on L1, each in a new block. */
export interface MoveL1 {
  /** Mines an empty block. */
  mine: () => Promise<{ number: bigint; timeMs: number }>
  /** A portal deposit of `amount` committed to `recipientCommitment`, with its block's time. */
  deposit: (
    portal: Address,
    recipientCommitment: Hex,
    amount: bigint,
  ) => Promise<L1Tx & { deposit: MoveDeposit }>
  /** `portal` spends `withdrawalId`, as a release does. */
  release: (portal: Address, withdrawalId: Hex) => Promise<L1Tx>
  /** A relayer runs the burn's escrow; `assets`: what the vault took in or paid out. */
  run: (burn: BuiltBurn<"skyEscrow">) => Promise<L1Tx & { assets: bigint }>
  /** A release pays `escrow` `amount` of the token a recovery returns, and nothing runs it. */
  fund: (escrow: Address, amount: bigint) => Promise<L1Tx>
  /** Any account sends `call`; a run names the escrow it empties. */
  send: (call: L1Call, escrow?: Address) => Promise<L1Tx>
  /** What `shares` of the held token redeem for now; `assetsOf` rounds down from it. */
  sharePrice: () => Promise<{ shares: bigint; assets: bigint }>
  /** What the base bridge's plain withdrawal executor takes from each burn. */
  withdrawalFee: bigint
}

export interface MoveRoutesSubject<
  L1 extends MoveL1,
  H extends RouteHolding,
  R extends MoveRoute,
  Q extends MoveQuote,
> {
  /** A fresh L1 for one case. */
  l1: () => L1 | Promise<L1>
  routes: (l1: L1) => MoveRoutes<H, R, Q>
  holding: H
  /** Enough of the burned token for a move either way. */
  amount: bigint
  /** A token `token` reads, and what it reads. */
  token: { address: Address; symbol: string; decimals: number }
  /** What `limits` reads for the holding's terms. */
  limits: MoveLimits
  keys: RecoveryKeys
  /** The escrow tip `quote` prices; undefined for a rail without an escrow. */
  escrowTip: (quote: Q) => bigint | undefined
  /** The token an unrun escrow's recovery returns for a move in `direction`. */
  recoveredToken: (route: R, direction: MoveDirection) => Address
}

export const NONCE = `0x${"3e".repeat(32)}` as Hex
export const OTHER_NONCE = `0x${"4f".repeat(32)}` as Hex
const OTHER_FACTORY = `0x${"fb".repeat(20)}` as Address
const OTHER_PORTAL = `0x${"fc".repeat(20)}` as Address
const RECIPIENT = `0x${"0d".repeat(20)}` as Address
const WITHDRAWAL = `0x${"5a".repeat(32)}` as Hex
const OTHER_WITHDRAWAL = `0x${"6b".repeat(32)}` as Hex
const DAY_MS = 24 * 60 * 60_000
const DIRECTIONS = ["in", "out"] as const

/** `in` deposits into the held bridge's portal from the base's; `out` the other way. */
export const sides = <Side>(pair: { base: Side; held: Side }, direction: MoveDirection) =>
  direction === "in"
    ? { source: pair.base, destination: pair.held }
    : { source: pair.held, destination: pair.base }

function escrowBurn(built: BuiltBurn): BuiltBurn<"skyEscrow"> {
  if (built.rail !== "skyEscrow") throw new Error(`a ${built.rail} burn pays no escrow`)
  return built
}

/** The move record a build saves, from what the burn was built with, and its burn's withdrawal. */
function moveOf<Rail extends BuiltBurn["rail"]>(
  built: BuiltBurn<Rail>,
  args: MoveArgs,
  holding: RouteHolding,
): RailMove<Rail> & { withdrawalId: Hex } {
  const { direction, amount, nonce, recipientCommitment } = args
  return {
    ...built,
    withdrawalId: WITHDRAWAL,
    id: `move-${nonce}`,
    holdingId: holding.id,
    direction,
    amount,
    nonce,
    recipientCommitment,
    scanFrom: 0n,
    phase: "burned",
    startTime: 0,
  }
}

export function moveRoutesContract<
  L1 extends MoveL1,
  H extends RouteHolding,
  R extends MoveRoute,
  Q extends MoveQuote,
>(subject: MoveRoutesSubject<L1, H, R, Q>): void {
  const { holding, amount, keys } = subject
  const isEscrowRail = holding.rail === "skyEscrow"
  const open = async () => {
    const l1 = await subject.l1()
    const routes = subject.routes(l1)
    return { l1, routes, route: await routes.read(holding) }
  }
  const build = async (
    routes: MoveRoutes<H, R, Q>,
    route: R,
    direction: MoveDirection,
    nonce = NONCE,
  ) => {
    const quote = await routes.quote(route, direction, amount)
    const from = AztecAddress.fromBigIntUnsafe(1n)
    const args: MoveArgs = {
      direction,
      amount,
      from,
      nonce,
      recipientCommitment: await routes.commitment(new Fr(1n), from),
      recovery: { salt: keys.salt, account: keys.account },
    }
    const built = routes.build(route, args, quote)
    return { built, args, quote, move: moveOf(built, args, holding) }
  }
  const recovery = async (
    routes: MoveRoutes<H, R, Q>,
    route: R,
    { move }: Awaited<ReturnType<typeof build>>,
  ) => {
    if (!routes.recover) throw new Error("the escrow rail recovers")
    return routes.recover(route, move, keys, RECIPIENT, async () => {
      throw new Error("an escrow's recovery releases nothing")
    })
  }

  it("reads the portal and L1 token of the holding's two bridges", async () => {
    const { route } = await open()
    expect(isAddressEqual(route.base.portal, holding.base.portal as Address)).toBe(true)
    expect(isAddressEqual(route.base.token, holding.base.underlying as Address)).toBe(true)
    expect(isAddressEqual(route.held.portal, holding.held.portal as Address)).toBe(true)
    expect(isAddressEqual(route.held.token, holding.held.underlying as Address)).toBe(true)
  })

  it("quotes either way less than the burn, with floors at or below its figures", async () => {
    const { routes, route } = await open()
    for (const direction of DIRECTIONS) {
      const quote = await routes.quote(route, direction, amount)
      expect(quote.routed).toBeGreaterThan(0n)
      expect(quote.routed + quote.relayerTip).toBeLessThanOrEqual(amount)
      expect(quote.minOut).toBeLessThanOrEqual(quote.expectedOut)
      expect(quote.conversionMinOut).toBeLessThanOrEqual(quote.conversionOut)
    }
  })

  // An escrow rail's move in pays the base's plain executor, which takes a fee; the multi-step
  // executor takes none.
  it("charges a fee only on an escrow rail's move in, and routes what the fee and tips leave", async () => {
    const { l1, routes, route } = await open()
    const quote = {
      in: await routes.quote(route, "in", amount),
      out: await routes.quote(route, "out", amount),
    }
    if (isEscrowRail) expect(l1.withdrawalFee).toBeGreaterThan(0n)
    expect(quote.in.withdrawalFee).toBe(isEscrowRail ? l1.withdrawalFee : 0n)
    expect(quote.out.withdrawalFee).toBe(0n)
    for (const q of [quote.in, quote.out])
      expect(q.relayerTip + q.withdrawalFee + q.routed).toBe(amount)
  })

  it("builds either way a burn of its rail, which carries its args; an escrow burn its tip", async () => {
    const { routes, route } = await open()
    expect(routes.rail).toBe(holding.rail)
    const skyRoutes = new Set<unknown>()
    for (const direction of DIRECTIONS) {
      const { built, args, quote } = await build(routes, route, direction)
      const burn: BuiltBurn = built
      expect(burn.rail).toBe(holding.rail)
      const tip = burn.rail === "skyEscrow" ? burn.escrow.tip : undefined
      expect(tip).toBe(subject.escrowTip(quote))
      if (burn.rail === "executor") {
        const { destination } = sides(route, direction)
        expect(isAddressEqual(burn.destination, destination.portal)).toBe(true)
        const run = burn.withdrawal.multiStep
        expect(run?.operation.executor.toString().toLowerCase()).toBe(burn.target.toLowerCase())
        expect(run?.operation.amount).toBe(args.amount)
        const memo = run?.operation.recoveryMemo ?? Buffer.alloc(0)
        expect(decodeWithdrawalMemo(memo).vaultMove?.nonce).toBe(args.nonce)
        expect(burn.withdrawal.escrow).toBeUndefined()
        continue
      }
      expect(isAddressEqual(burn.target, burn.escrow.address)).toBe(true)
      const paid = burn.withdrawal.escrow
      expect(paid?.escrow.toString().toLowerCase()).toBe(burn.target.toLowerCase())
      const sky = paid && "sky" in paid.memo ? paid.memo.sky : undefined
      expect(sky).toMatchObject({
        recipientCommitment: args.recipientCommitment,
        nonce: args.nonce,
        relayerTip: burn.escrow.tip,
      })
      skyRoutes.add(sky?.route)
    }
    if (isEscrowRail) expect(skyRoutes.size).toBe(2)
  })

  it("commits a deposit to a 32-byte field, one per secret and recipient", async () => {
    const { routes } = await open()
    const recipient = AztecAddress.fromBigIntUnsafe(1n)
    const commitment = await routes.commitment(new Fr(1n), recipient)
    expect(commitment).toMatch(/^0x[0-9a-f]{64}$/)
    expect(await routes.commitment(new Fr(1n), recipient)).toBe(commitment)
    expect(await routes.commitment(new Fr(2n), recipient)).not.toBe(commitment)
    const other = AztecAddress.fromBigIntUnsafe(2n)
    expect(await routes.commitment(new Fr(1n), other)).not.toBe(commitment)
  })

  it("finds a deposit by commitment on the destination portal, only in its block", async () => {
    const { l1, routes, route } = await open()
    const commitment = `0x00${"5c".repeat(31)}` as Hex
    const other = `0x00${"6d".repeat(31)}` as Hex
    const destination = sides(route, "in").destination.portal
    await l1.deposit(destination, other, 5n)
    const prior = await l1.mine()
    const made = await l1.deposit(destination, commitment, 98n)
    const after = await l1.mine()
    expect(made.deposit.at).toBeGreaterThanOrEqual(prior.timeMs)
    expect(made.deposit.at).toBeLessThanOrEqual(after.timeMs)
    const at = { from: made.blockNumber, to: made.blockNumber }
    expect(await routes.findDeposit(route, "in", commitment, at)).toEqual({
      txHash: made.txHash,
      blockNumber: made.blockNumber,
      deposit: made.deposit,
    })
    const later = { from: made.blockNumber + 1n, to: after.number }
    expect(await routes.findDeposit(route, "in", commitment, later)).toBeUndefined()
    const before = { from: 0n, to: made.blockNumber - 1n }
    expect(await routes.findDeposit(route, "in", commitment, before)).toBeUndefined()
    expect(await routes.findDeposit(route, "out", commitment, at)).toBeUndefined()
    expect(await routes.findDeposit(route, "in", other, at)).toBeUndefined()
  })

  it("reads a withdrawal as spent only once its source portal spends that one", async () => {
    const { l1, routes, route } = await open()
    expect(await routes.withdrawalSpent(route, "in", WITHDRAWAL)).toBe(false)
    await l1.release(sides(route, "in").source.portal, WITHDRAWAL)
    expect(await routes.withdrawalSpent(route, "in", WITHDRAWAL)).toBe(true)
    expect(await routes.withdrawalSpent(route, "out", WITHDRAWAL)).toBe(false)
    expect(await routes.withdrawalSpent(route, "in", OTHER_WITHDRAWAL)).toBe(false)
  })

  it("finds a withdrawal's release on its source portal, only in its block, at its time", async () => {
    const { l1, routes, route } = await open()
    const prior = await l1.mine()
    const made = await l1.release(sides(route, "in").source.portal, WITHDRAWAL)
    const after = await l1.mine()
    const at = { from: made.blockNumber, to: made.blockNumber }
    const found = await routes.release(route, "in", WITHDRAWAL, at)
    expect(found?.txHash).toBe(made.txHash)
    expect(found?.at).toBeGreaterThanOrEqual(prior.timeMs)
    expect(found?.at).toBeLessThanOrEqual(after.timeMs)
    const later = { from: made.blockNumber + 1n, to: after.number }
    expect(await routes.release(route, "in", WITHDRAWAL, later)).toBeUndefined()
    expect(await routes.release(route, "out", WITHDRAWAL, at)).toBeUndefined()
    expect(await routes.release(route, "in", OTHER_WITHDRAWAL, at)).toBeUndefined()
  })

  it("owns the burns its route builds, and none of another factory, portal or rail", async () => {
    const { routes, route } = await open()
    const { built, args } = await build(routes, route, "in")
    const read = {
      txHash: `0x${"01".repeat(32)}`,
      timestampMs: 0,
      withdrawalId: WITHDRAWAL,
      amount: args.amount,
      nonce: args.nonce,
      recipientCommitment: args.recipientCommitment,
    }
    const burn: MoveBurn = { ...read, ...built }
    expect(routes.owns(route, burn)).toBe(true)
    if (burn.rail === "skyEscrow") {
      const elsewhere = { ...burn.escrow, factory: OTHER_FACTORY }
      expect(routes.owns(route, { ...read, rail: "skyEscrow", escrow: elsewhere })).toBe(false)
      const executorBurn = { ...read, rail: "executor" as const, destination: route.held.portal }
      expect(routes.owns(route, executorBurn)).toBe(false)
    }
    if (burn.rail === "executor") {
      expect(routes.owns(route, { ...burn, destination: OTHER_PORTAL })).toBe(false)
      const escrow = { factory: OTHER_FACTORY, address: OTHER_FACTORY, tip: 0n }
      expect(routes.owns(route, { ...read, rail: "skyEscrow", escrow })).toBe(false)
    }
  })

  it.runIf(isEscrowRail)(
    "reads an escrow's run and the vault's figure, only over its blocks",
    async () => {
      const { l1, routes, route } = await open()
      const { built, move } = await build(routes, route, "in")
      const other = await build(routes, route, "in", OTHER_NONCE)
      const head = await routes.head()
      expect(await routes.outcome(route, move, { from: 0n, to: head })).toBeUndefined()
      const otherRan = await l1.run(escrowBurn(other.built))
      const atOther = { from: otherRan.blockNumber, to: otherRan.blockNumber }
      expect(await routes.outcome(route, move, atOther)).toBeUndefined()
      const ran = await l1.run(escrowBurn(built))
      const after = await l1.mine()
      const at = { from: ran.blockNumber, to: ran.blockNumber }
      expect(await routes.outcome(route, move, at)).toEqual({ kind: "ran", assets: ran.assets })
      const before = { from: 0n, to: ran.blockNumber - 1n }
      expect(await routes.outcome(route, move, before)).toBeUndefined()
      const later = { from: ran.blockNumber + 1n, to: after.number }
      expect(await routes.outcome(route, move, later)).toBeUndefined()
    },
  )

  it.runIf(isEscrowRail)(
    "recovers an unrun escrow's token to an address either way, which its outcome reads, and none of an empty escrow",
    async () => {
      for (const direction of DIRECTIONS) {
        const { l1, routes, route } = await open()
        const mine = await build(routes, route, direction)
        const other = await build(routes, route, direction, OTHER_NONCE)
        const empty = { code: "move.escrowEmpty" }
        await expect(recovery(routes, route, mine)).rejects.toMatchObject(empty)
        for (const { built } of [mine, other]) await l1.fund(escrowBurn(built).escrow.address, 97n)
        const otherSent = await l1.send(await recovery(routes, route, other))
        const atOther = { from: otherSent.blockNumber, to: otherSent.blockNumber }
        expect(await routes.outcome(route, mine.move, atOther)).toBeUndefined()
        const sent = await l1.send(await recovery(routes, route, mine))
        const at = { from: sent.blockNumber, to: sent.blockNumber }
        const outcome = await routes.outcome(route, mine.move, at)
        if (outcome?.kind !== "recovered") throw new Error(`the outcome is ${outcome?.kind}`)
        expect(outcome).toMatchObject({ txHash: sent.txHash, blockNumber: sent.blockNumber })
        expect(isAddressEqual(outcome.to, RECIPIENT)).toBe(true)
        const token = subject.recoveredToken(route, direction)
        expect(isAddressEqual(outcome.token, token)).toBe(true)
        const before = { from: 0n, to: sent.blockNumber - 1n }
        expect(await routes.outcome(route, mine.move, before)).toBeUndefined()
      }
    },
  )

  it.runIf(isEscrowRail)(
    "reads a run over a recovery of the same escrow in one range",
    async () => {
      const { l1, routes, route } = await open()
      const made = await build(routes, route, "in")
      await l1.fund(escrowBurn(made.built).escrow.address, 97n)
      const call = await recovery(routes, route, made)
      const ran = await l1.run(escrowBurn(made.built))
      const sent = await l1.send(call)
      const range = { from: ran.blockNumber, to: sent.blockNumber }
      expect(await routes.outcome(route, made.move, range)).toEqual({
        kind: "ran",
        assets: ran.assets,
      })
    },
  )

  it("rejects a deposit search or an outcome read whose signal has aborted", async () => {
    const { routes, route } = await open()
    const { move } = await build(routes, route, "in")
    const range = { from: 0n, to: await routes.head() }
    const signal = AbortSignal.abort()
    const aborted = { name: "AbortError" }
    const commitment = move.recipientCommitment
    await expect(routes.findDeposit(route, "in", commitment, range, signal)).rejects.toMatchObject(
      aborted,
    )
    await expect(routes.outcome(route, move, range, signal)).rejects.toMatchObject(aborted)
  })

  it.runIf(isEscrowRail)(
    "runs a funded escrow either way, which its outcome reads, and refuses one with nothing to run",
    async () => {
      for (const direction of DIRECTIONS) {
        const { l1, routes, route } = await open()
        const { move } = await build(routes, route, direction)
        const record: MoveRecord = move
        if (!routes.run || record.rail !== "skyEscrow") throw new Error("the escrow rail runs")
        const run = () => routes.run!(route, move, keys)
        await expect(run()).rejects.toMatchObject({ code: "move.escrowRan" })
        await l1.fund(record.escrow.address, 97n)
        const sent = await l1.send(await run(), record.escrow.address)
        const at = { from: sent.blockNumber, to: sent.blockNumber }
        expect(await routes.outcome(route, move, at)).toEqual({ kind: "ran", assets: 97n })
        await expect(run()).rejects.toMatchObject({ code: "move.escrowRan" })
      }
    },
  )

  it("reads the terms' limits, and redeems shares at the vault's price, rounded down", async () => {
    const { l1, routes, route } = await open()
    expect(await routes.limits(route)).toEqual(subject.limits)
    const price = await l1.sharePrice()
    for (const shares of [0n, 1n, amount, amount + 1n, price.shares, 3n * price.shares]) {
      expect(await routes.assetsOf(route, shares)).toBe((shares * price.assets) / price.shares)
    }
  })

  it("reads a token's symbol and decimals", async () => {
    const { routes } = await open()
    const { address, symbol, decimals } = subject.token
    expect(await routes.token(address)).toEqual({ symbol, decimals })
  })

  it("finds the first block at or after a time, or the head before L1 reaches it", async () => {
    const { l1, routes } = await open()
    const first = await l1.mine()
    const second = await l1.mine()
    expect(await routes.head()).toBe(second.number)
    expect(await routes.blockAt(first.timeMs)).toBe(first.number)
    expect(await routes.blockAt(first.timeMs + 1)).toBe(second.number)
    expect(await routes.blockAt(second.timeMs + DAY_MS)).toBe(second.number)
  })
}
