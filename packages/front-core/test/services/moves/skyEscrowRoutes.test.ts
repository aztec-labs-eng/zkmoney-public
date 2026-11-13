// @vitest-environment node
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { MULTICALL3_ADDRESS, quoteSkyReleaseTip } from "@obsidion/sdk"
import type { ScannedWithdrawEvent } from "@obsidion/sdk"
import { SkyEscrowFactoryAbi, SkyRoute } from "@oxide/experiments/sky/sky_savings.js"
import { EscrowBaseAbi } from "@oxide/l1-contracts/artifacts.js"
import { L1_OPERATION_BROADCAST_TIERS } from "@oxide/oxide-lib/l1_operation_calldata.js"
import { decodePlainWithdrawalPayload } from "@oxide/oxide-lib/plain_withdrawal_executor.js"
import { decodeFunctionData, getAddress, isAddressEqual, maxUint256, multicall3Abi } from "viem"
import type { Address, Hex } from "viem"
import { describe, expect, it } from "vitest"
import type { MoveDirection } from "../../../src/engine/moveTransition"
import {
  l1ExecutorReads,
  skyEscrowExecutors,
  skyEscrowMoveBurns,
  skyEscrowRoutes,
} from "../../../src/core/services/moves/skyEscrowRoutes"
import type { SkyEscrowRoute } from "../../../src/core/services/moves/skyEscrowRoutes"
import { SWAP_ESCROW_RECOVERY_DEADLINE_S } from "../../../src/oxide/swapEscrowRecovery"
import {
  DAI,
  DAI_PORTAL,
  fakeL1,
  L2_BROADCASTER,
  MAIN_EXECUTOR,
  MAIN_SUBSIDY,
  RECOVERY_KEYS,
  RETIRED_SKY_EXECUTOR,
  SKY_EXECUTOR,
  SKY_FACTORY,
  SKY_HOLDING,
  SKY_SUBSIDY,
  STRAY_EXECUTOR,
  SUSDS_PORTAL,
} from "./fixtures"
import type { FakeL1 } from "./fixtures"
import { moveRoutesContract, NONCE } from "./moveRoutesContract"

const WAD = 10n ** 18n
const AMOUNT = 100n * WAD
/** More than any release costs, so the release tip it prices is zero. */
const COVERING = 10n ** 30n
const OTHER = `0x${"0f".repeat(20)}` as Address
/** DAI a release leaves at an escrow. */
const FUNDED = 97n * WAD

/** The wallet's Broadcaster binding: the builder only names its broadcast methods. */
const broadcaster = async (address: string) =>
  ({
    address: AztecAddress.fromStringUnsafe(address),
    methods: Object.fromEntries(
      L1_OPERATION_BROADCAST_TIERS.map(({ method }) => [method, () => ({})]),
    ),
  } as never)

const NONCE_BYTES = new Uint8Array(32).fill(7)
const routesOver = (l1: FakeL1) =>
  skyEscrowRoutes({ l1: l1.client, broadcaster, nonce: () => NONCE_BYTES })

const open = async (l1 = fakeL1()) => {
  const routes = routesOver(l1)
  return { l1, routes, route: await routes.read(SKY_HOLDING) }
}

const argsFor = async (routes: ReturnType<typeof routesOver>, direction: MoveDirection) => ({
  direction,
  amount: AMOUNT,
  from: AztecAddress.fromBigIntUnsafe(1n),
  nonce: NONCE,
  recipientCommitment: await routes.commitment(new Fr(1n), AztecAddress.fromBigIntUnsafe(1n)),
  recovery: { salt: RECOVERY_KEYS.salt, account: RECOVERY_KEYS.account },
})

/** Sky's recovery takes its escrow's DAI and releases no withdrawal. */
const noRelease = () => Promise.reject(new Error("a Sky recovery releases nothing"))

/** An unstake built on `route`, and the move a store keeps of it. */
const unstake = async (routes: ReturnType<typeof routesOver>, route: SkyEscrowRoute) => {
  const args = await argsFor(routes, "out")
  const built = routes.build(route, args, await routes.quote(route, "out", AMOUNT))
  const move = {
    ...built,
    id: "move-1",
    holdingId: SKY_HOLDING.id,
    direction: "out" as const,
    amount: AMOUNT,
    nonce: NONCE,
    recipientCommitment: args.recipientCommitment,
    scanFrom: 0n,
    phase: "burned" as const,
    startTime: 0,
    withdrawalId: `0x${"5a".repeat(32)}` as Hex,
  }
  return { built, move }
}

describe("skyEscrowRoutes keeps the MoveRoutes contract", () => {
  moveRoutesContract({
    l1: () => fakeL1(),
    routes: routesOver,
    holding: SKY_HOLDING,
    amount: AMOUNT,
    token: { address: DAI, symbol: "DAI", decimals: 18 },
    limits: { maxDeposit: maxUint256, maxRedeem: maxUint256 },
    keys: RECOVERY_KEYS,
    escrowTip: (quote) => quote.escrowTip,
    recoveredToken: (route) => route.base.token,
  })
})

describe("skyEscrowRoutes", () => {
  const withExecutors = (main: Address, sky: Address) => ({
    ...SKY_HOLDING,
    base: {
      ...SKY_HOLDING.base,
      tuple: { ...SKY_HOLDING.base.tuple, plainWithdrawalExecutor: main },
    },
    escrow: { ...SKY_HOLDING.escrow, withdrawalExecutor: sky },
  })
  const PORTALS = { dai: DAI_PORTAL, sUsds: SUSDS_PORTAL }
  it.each([
    { what: "factory's DAI", holding: SKY_HOLDING, portals: { ...PORTALS, dai: OTHER } },
    { what: "factory's sUSDS", holding: SKY_HOLDING, portals: { ...PORTALS, sUsds: OTHER } },
    {
      what: "Main executor",
      holding: withExecutors(STRAY_EXECUTOR, SKY_EXECUTOR),
      portals: PORTALS,
    },
    {
      what: "Sky executor",
      holding: withExecutors(MAIN_EXECUTOR, MAIN_EXECUTOR),
      portals: PORTALS,
    },
  ])("refuses a $what portal other than the holding's bridges'", async ({ holding, portals }) => {
    const l1 = fakeL1()
    l1.factoryPortals = portals
    await expect(routesOver(l1).read(holding)).rejects.toMatchObject({
      code: "move.routeMismatch",
    })
  })

  it.each(["plainWithdrawalExecutor", "operationExecutor", "l2Broadcaster"] as const)(
    "refuses a Main bridge that names no %s",
    async (field) => {
      const holding = {
        ...SKY_HOLDING,
        base: { ...SKY_HOLDING.base, tuple: { ...SKY_HOLDING.base.tuple, [field]: undefined } },
      }
      await expect(routesOver(fakeL1()).read(holding)).rejects.toMatchObject({
        code: "config.invalid",
      })
    },
  )

  it("reports an L1 failure while it reads or quotes a route under a code, the fault as its cause", async () => {
    const l1 = fakeL1()
    const fault = new Error("execution reverted")
    const failing = (method: "readContract" | "simulateBlocks") =>
      skyEscrowRoutes({
        l1: { ...l1.client, [method]: () => Promise.reject(fault) },
        broadcaster,
        nonce: () => NONCE_BYTES,
      })
    await expect(failing("readContract").read(SKY_HOLDING)).rejects.toMatchObject({
      code: "move.routeUnread",
      cause: fault,
    })
    const { route } = await open(l1)
    // The sdk tries the run through both executor shapes and reports the two faults together.
    await expect(failing("simulateBlocks").quote(route, "in", AMOUNT)).rejects.toMatchObject({
      code: "move.routeUnread",
      cause: { errors: [fault, fault] },
    })
  })

  it("prices each direction's release with the subsidy of the executor its burn pays", async () => {
    const { l1, routes, route } = await open()
    l1.subsidies.set(SKY_SUBSIDY.toLowerCase(), COVERING)
    expect((await routes.quote(route, "out", AMOUNT)).releaseTip).toBe(0n)
    expect((await routes.quote(route, "in", AMOUNT)).releaseTip).toBeGreaterThan(0n)
    l1.subsidies.set(SKY_SUBSIDY.toLowerCase(), 0n)
    l1.subsidies.set(MAIN_SUBSIDY.toLowerCase(), COVERING)
    expect((await routes.quote(route, "in", AMOUNT)).releaseTip).toBe(0n)
    expect((await routes.quote(route, "out", AMOUNT)).releaseTip).toBeGreaterThan(0n)
    l1.subsidies.set(MAIN_SUBSIDY.toLowerCase(), 0n)
    const releaseTip = async (direction: MoveDirection) =>
      (await routes.quote(route, direction, AMOUNT)).releaseTip
    expect(await releaseTip("out")).toBeGreaterThan(await releaseTip("in"))
  })

  it("quotes a stake as DAI routed into shares, less Main's fee and both tips", async () => {
    const { l1, routes, route } = await open()
    l1.price = { shares: WAD, assets: 2n * WAD }
    const quote = await routes.quote(route, "in", AMOUNT)
    const routed = AMOUNT - l1.withdrawalFee - quote.releaseTip - quote.escrowTip
    expect(quote).toEqual({
      releaseTip: quote.releaseTip,
      escrowTip: quote.escrowTip,
      withdrawalFee: l1.withdrawalFee,
      routed,
      relayerTip: quote.releaseTip + quote.escrowTip,
      conversionOut: routed,
      conversionMinOut: 0n,
      expectedOut: routed / 2n,
      minOut: 0n,
    })
    expect(quote.escrowTip).toBeGreaterThan(0n)
  })

  it("quotes an unstake as the DAI it redeems for, with both tips in shares", async () => {
    const { l1, routes, route } = await open()
    l1.price = { shares: WAD, assets: 2n * WAD }
    const quote = await routes.quote(route, "out", AMOUNT)
    const net = 2n * AMOUNT - quote.releaseTip - quote.escrowTip
    expect(quote).toEqual({
      releaseTip: quote.releaseTip,
      escrowTip: quote.escrowTip,
      withdrawalFee: 0n,
      routed: net / 2n,
      relayerTip: AMOUNT - net / 2n,
      conversionOut: net,
      conversionMinOut: 0n,
      expectedOut: 2n * AMOUNT,
      minOut: 0n,
    })
  })

  it("names who Main's fee pays moving in, where its executor names anyone", async () => {
    const { l1, routes, route } = await open()
    expect(await routes.quote(route, "in", AMOUNT)).not.toHaveProperty("feeBeneficiary")
    l1.beneficiary = OTHER
    const named = await open(l1)
    const quote = await named.routes.quote(named.route, "in", AMOUNT)
    expect(quote.feeBeneficiary).toBe(getAddress(OTHER))
  })

  it.each([
    { direction: "in" as const, route: SkyRoute.Stake, smallest: 1n },
    { direction: "out" as const, route: SkyRoute.Unstake, smallest: 1n },
  ])(
    "refuses a move $direction its costs leave nothing of, naming them in the burned token",
    async ({ direction, route: skyRoute, smallest }) => {
      const { l1, routes, route } = await open()
      l1.price = { shares: WAD, assets: 2n * WAD }
      const executor = route.executors[direction]
      const burned = (dai: bigint) => (direction === "in" ? dai : dai / 2n)
      const tipsAt = async (amount: bigint) => {
        const error = await routes.quote(route, direction, amount).catch((e: unknown) => e)
        expect(error).toMatchObject({ code: "move.tipsExceedAmount" })
        return BigInt((error as { data: { tips: string } }).data.tips)
      }
      const release = await quoteSkyReleaseTip(l1.client, executor.subsidy, skyRoute)
      expect(await tipsAt(smallest)).toBe(burned(executor.fee + release.relayerTip))
      // A covered release leaves the escrow's tip as the one cost beyond the fee.
      l1.subsidies.set(executor.subsidy.toLowerCase(), COVERING)
      const { escrowTip } = await routes.quote(route, direction, AMOUNT)
      const funded = direction === "in" ? executor.fee + 1n : 1n
      expect(await tipsAt(funded)).toBe(burned(executor.fee + escrowTip))
    },
  )

  it.each([
    { direction: "in" as const, route: SkyRoute.Stake, executor: MAIN_EXECUTOR },
    { direction: "out" as const, route: SkyRoute.Unstake, executor: SKY_EXECUTOR },
  ])(
    "builds a move $direction's burn through $executor, broadcast by Main, on the quoted tips",
    async ({ direction, route: skyRoute, executor }) => {
      const { l1, routes, route } = await open()
      const quote = await routes.quote(route, direction, AMOUNT)
      const fee = direction === "in" ? l1.withdrawalFee : 0n
      const built = routes.build(route, await argsFor(routes, direction), quote)
      const options = built.withdrawal.escrow
      expect(options).toMatchObject({
        executor: getAddress(executor),
        withdrawalFee: fee,
        broadcaster: AztecAddress.fromStringUnsafe(L2_BROADCASTER).toString(),
        memo: { sky: { route: skyRoute, relayerTip: quote.escrowTip, factory: SKY_FACTORY } },
      })
      const payload = decodePlainWithdrawalPayload(options!.userPayload)
      expect(payload.relayerTip).toBe(quote.releaseTip)
      expect(built.escrow.tip).toBe(quote.escrowTip)
    },
  )

  it("reads only a recovery of DAI as the move's, after one of stray sUSDS", async () => {
    const { l1, routes, route } = await open()
    const { built, move } = await unstake(routes, route)
    const stray = l1.recoveryCall({
      escrow: built.escrow.address,
      to: OTHER,
      token: SKY_HOLDING.held.underlying as Address,
    })
    const first = await l1.send(stray)
    const strayOnly = { from: first.blockNumber, to: first.blockNumber }
    expect(await routes.outcome(route, move, strayOnly)).toBeUndefined()
    await l1.fund(built.escrow.address, FUNDED)
    const sent = await l1.send(await routes.recover!(route, move, RECOVERY_KEYS, OTHER, noRelease))
    const both = { from: first.blockNumber, to: sent.blockNumber }
    expect(await routes.outcome(route, move, both)).toMatchObject({
      kind: "recovered",
      txHash: sent.txHash,
      token: getAddress(DAI),
    })
  })

  it("recovers an unrun escrow's DAI after deploying it, in one Multicall3 call", async () => {
    const { l1, routes, route } = await open()
    const { built, move } = await unstake(routes, route)
    await l1.fund(built.escrow.address, FUNDED)
    const head = await l1.client.getBlock()
    const call = await routes.recover!(route, move, RECOVERY_KEYS, OTHER, noRelease)
    expect(call.to).toBe(MULTICALL3_ADDRESS)
    const { args } = decodeFunctionData({ abi: multicall3Abi, data: call.data })
    const [deploy, recover] = args[0] as readonly { target: Address; callData: Hex }[]
    expect(deploy?.target).toBe(SKY_FACTORY)
    const deployed = decodeFunctionData({ abi: SkyEscrowFactoryAbi, data: deploy!.callData })
    expect(deployed.functionName).toBe("deploy")
    expect(isAddressEqual(recover!.target, built.escrow.address)).toBe(true)
    const recovered = decodeFunctionData({ abi: EscrowBaseAbi, data: recover!.callData })
    const [, account, , to, token, nonce, deadline] = recovered.args as readonly unknown[]
    expect({ account, to, token, nonce, deadline }).toEqual({
      account: getAddress(RECOVERY_KEYS.account),
      to: getAddress(OTHER),
      token: route.base.token,
      nonce: `0x${"07".repeat(32)}`,
      deadline: head.timestamp + SWAP_ESCROW_RECOVERY_DEADLINE_S,
    })
    const sent = await l1.send(call)
    const at = { from: sent.blockNumber, to: sent.blockNumber }
    expect(await routes.outcome(route, move, at)).toMatchObject({
      kind: "recovered",
      txHash: sent.txHash,
      to: getAddress(OTHER),
    })
  })

  it("recovers DAI that reached an escrow its run deployed directly, and none the keys do not open", async () => {
    const { l1, routes, route } = await open()
    const { built, move } = await unstake(routes, route)
    await l1.run(built)
    await l1.fund(built.escrow.address, FUNDED)
    const call = await routes.recover!(route, move, RECOVERY_KEYS, OTHER, noRelease)
    expect(isAddressEqual(call.to, built.escrow.address)).toBe(true)
    const others = { ...RECOVERY_KEYS, salt: new Fr(99n) }
    await expect(routes.recover!(route, move, others, OTHER, noRelease)).rejects.toMatchObject({
      code: "move.recoveryKeysMismatch",
    })
  })

  it("refuses to recover an escrow that holds no DAI, before the account signs", async () => {
    const { l1, routes, route } = await open()
    const { built, move } = await unstake(routes, route)
    const signed: Hex[] = []
    const keys = {
      ...RECOVERY_KEYS,
      sign: async (digest: Hex) => {
        signed.push(digest)
        return RECOVERY_KEYS.sign(digest)
      },
    }
    const empty = { code: "move.escrowEmpty" }
    await expect(routes.recover!(route, move, keys, OTHER, noRelease)).rejects.toMatchObject(empty)
    await l1.fund(built.escrow.address, FUNDED)
    await l1.run(built)
    await expect(routes.recover!(route, move, keys, OTHER, noRelease)).rejects.toMatchObject(empty)
    expect(signed).toEqual([])
  })
})

describe("skyEscrowExecutors", () => {
  it("reads the holding's Sky executor as fee-free, and Main's with its fee", async () => {
    const l1 = fakeL1()
    const read = skyEscrowExecutors(l1ExecutorReads(l1.client), [SKY_HOLDING])
    expect(await read(SKY_EXECUTOR)).toEqual({
      address: getAddress(SKY_EXECUTOR),
      kind: "sky",
      portal: getAddress(SUSDS_PORTAL),
      fee: 0n,
    })
    expect(await read(MAIN_EXECUTOR)).toMatchObject({ kind: "plain", fee: l1.withdrawalFee })
  })

  it("reads a Sky executor the holding no longer names as fee-free too", async () => {
    const read = skyEscrowExecutors(l1ExecutorReads(fakeL1().client), [SKY_HOLDING])
    expect(await read(RETIRED_SKY_EXECUTOR)).toMatchObject({ kind: "sky", fee: 0n })
  })

  it("fails to read an address that is no executor", async () => {
    const read = skyEscrowExecutors(l1ExecutorReads(fakeL1().client), [SKY_HOLDING])
    await expect(read(OTHER)).rejects.toThrow()
  })
})

describe("skyEscrowMoveBurns", () => {
  const ESCROW = getAddress(`0x${"e5".repeat(20)}`)
  const sky = (factory: Address) => ({
    factory,
    route: SkyRoute.Unstake,
    recipientCommitment: `0x${"0c".repeat(32)}` as Hex,
    recoveryCommitment: `0x${"0d".repeat(32)}` as Hex,
    relayerTip: 7n,
    nonce: NONCE,
  })
  // The source keeps a memo only when its args derive `l1Recipient`, so the escrow is stubbed.
  const burn = (n: number, memo?: ReturnType<typeof sky>): ScannedWithdrawEvent => ({
    txHash: `0x${n.toString(16).padStart(64, "0")}`,
    blockNumber: n,
    withdrawalId: `0x${n.toString(16).padStart(64, "1")}`,
    executor: SKY_EXECUTOR,
    withdrawalFee: 0n,
    l1Recipient: ESCROW,
    amount: 500n,
    proverTip: 0n,
    relayerTip: 3n,
    ...(memo ? { sky: memo } : {}),
  })
  const source = (burns: ScannedWithdrawEvent[], timestampMs?: number) => ({
    scanWithdrawals: async () => ({ withdrawals: burns, unread: [] }),
    blockTimestampMs: async () => timestampMs,
  })
  const range = { factories: [SKY_FACTORY], fromBlock: 0, toBlockExclusive: 10 }

  // A swap's or a bridge-out's burn pays an escrow too, here one of a factory at the same address.
  const { route: _, recipientCommitment: __, ...escrow } = sky(SKY_FACTORY)
  const swap: ScannedWithdrawEvent["swap"] = {
    ...escrow,
    output: "USDC",
    recipient: OTHER,
    daiForGas: 0n,
    minEthForGas: 0n,
  }
  const bridge: ScannedWithdrawEvent["bridge"] = {
    ...escrow,
    provider: "across",
    chainId: 8453,
    token: "USDT",
    recipient: OTHER,
    fee: 1n,
    minReceived: 2n,
  }

  it("reads the factories' escrow burns as moves, carrying each burn's withdrawal", async () => {
    const burns: ScannedWithdrawEvent[] = [
      burn(1, sky(SKY_FACTORY)),
      burn(2),
      burn(3, sky(OTHER)),
      { ...burn(4), swap },
      { ...burn(5), bridge },
    ]
    const { burns: read } = await skyEscrowMoveBurns(source(burns, 12_000), range)
    expect(read).toEqual([
      {
        rail: "skyEscrow",
        escrow: { factory: SKY_FACTORY, address: ESCROW, tip: 7n },
        txHash: burns[0]!.txHash,
        timestampMs: 12_000,
        withdrawalId: burns[0]!.withdrawalId,
        amount: 500n,
        nonce: NONCE,
        recipientCommitment: `0x${"0c".repeat(32)}`,
      },
    ])
  })

  it("fails a scan whose burn's block it cannot time, rather than drop the burn", async () => {
    await expect(
      skyEscrowMoveBurns(source([burn(1, sky(SKY_FACTORY))]), range),
    ).rejects.toMatchObject({ code: "scan.incomplete" })
  })
})
