import { describe, expect, it } from "vitest"
import { L1_OPERATION_TIP_MARGIN_BPS } from "@obsidion/core/constants"
import { ETH_USD_FEED_DECIMALS, weiToUSD } from "@oxide/oxide-client/eth_usd_price_feed.js"
import {
  UINT256_EXTRA_CALLDATA_GAS,
  WEI_PER_ETH,
  estimateL1OperationFeeValues,
  gasCostAtQuotePrice,
} from "@oxide/oxide-client/l1_operation_quote.js"
import { MultiStepExecutorAbi } from "@oxide/l1-contracts/artifacts.js"
import { decodeMultiStepPayload } from "@oxide/l1-contracts/multi_step/index.js"
import { decodeFunctionData, hexToBytes, parseGwei } from "viem"
import type { Address, Hex, PublicClient, StateOverride } from "viem"
import { mappingSlot } from "../../../src/oxide/escrow/swapOnWithdrawSimulator.js"
import { HOLDING_ADAPTERS } from "../../../src/oxide/holdings/adapters.js"
import { readHoldingRoute } from "../../../src/oxide/holdings/holdingDeployment.js"
import {
  RELEASE_GAS_WITHOUT_ROUTE,
  bufferedMinOut,
  quoteMove,
} from "../../../src/oxide/holdings/moveQuote.js"
import {
  DAI,
  EXECUTOR,
  SKY_CONVERTER_ADAPTER,
  USDS,
  VAULT,
  vaultHolding,
} from "./holdingFixtures.js"

const FEED = "0x000000000000000000000000000000000000feed" as Address
const NOW = 1_800_000_000n
const BASE_FEE = parseGwei("10")
const PRIORITY_FEE = parseGwei("1")
const FEES = await estimateL1OperationFeeValues({
  getBlock: async () => ({ baseFeePerGas: BASE_FEE }),
  estimateMaxPriorityFeePerGas: async () => PRIORITY_FEE,
} as unknown as PublicClient)
const ETH_USD = 3000n * 10n ** ETH_USD_FEED_DECIMALS
const ONE = 10n ** 18n
/** Assets per share. */
const RATE = (105n * ONE) / 100n
const BALANCE_SLOT = 2n
/** The simulated `execute`, including its intrinsic gas. */
const SIMULATED_GAS = 400_000n
const ROUTE_GAS = SIMULATED_GAS - 21_000n
const AMOUNT = 1_000n * ONE
const NO_MEMO = Buffer.alloc(0)

/** What the executor's simulated `execute` routes: its amount less the relayer tip it pays. */
function routedBy(data: Hex): bigint {
  const { args } = decodeFunctionData({ abi: MultiStepExecutorAbi, data })
  if (args.length !== 4) throw new Error("not the executor's execute")
  const [, amount, payload] = args
  return amount - decodeMultiStepPayload(Buffer.from(hexToBytes(payload))).relayerTip
}

const BPS = 10_000n

/**
 * A USDS vault paying `RATE` per share, less its fees, an ETH/USD feed, and a route that runs in
 * `SIMULATED_GAS` unless it routes more than `capacity`.
 */
function fakeChain({
  reverts = false,
  /** Each block read sees a base fee this much higher, as gas drifts between quotes. */
  baseFeeStep = 0n,
  depositFeeBps = 0n,
  redeemFeeBps = 0n,
  capacity = undefined as bigint | undefined,
} = {}) {
  /** The amount each simulated route got. */
  const routes: bigint[] = []
  let baseFee = BASE_FEE
  const readContract = async ({
    address,
    functionName,
    args = [],
    stateOverride,
  }: {
    address: Address
    functionName: string
    args?: readonly unknown[]
    stateOverride?: StateOverride
  }) => {
    const [arg] = args as [bigint & Address]
    if (address === SKY_CONVERTER_ADAPTER) return functionName === "DAI" ? DAI : USDS
    switch (functionName) {
      case "latestRoundData":
        return [0n, ETH_USD, 0n, NOW, 0n]
      case "decimals":
        return 18
      case "asset":
        return USDS
      case "balanceOf": {
        const wanted = mappingSlot(arg, BALANCE_SLOT)
        const hit = stateOverride?.[0]?.stateDiff?.find((entry) => entry.slot === wanted)
        return hit ? BigInt(hit.value) : 0n
      }
      case "previewDeposit":
        return (((arg * ONE) / RATE) * (BPS - depositFeeBps)) / BPS
      case "previewRedeem":
        return (((arg * RATE) / ONE) * (BPS - redeemFeeBps)) / BPS
      case "convertToShares":
        return (arg * ONE) / RATE
      case "convertToAssets":
        return (arg * RATE) / ONE
      default:
        throw new Error(`unexpected read ${functionName} on ${address}`)
    }
  }
  const simulateBlocks = async ({ blocks: [block] }: { blocks: [{ calls: [{ data: Hex }] }] }) => {
    const routed = routedBy(block.calls[0].data)
    routes.push(routed)
    const full = capacity !== undefined && routed > capacity
    return [
      {
        calls: [
          reverts || full
            ? { status: "failure", error: new Error("ERC4626Adapter__InsufficientOutput") }
            : { status: "success", gasUsed: SIMULATED_GAS },
        ],
      },
    ]
  }
  return {
    routes,
    getChainId: async () => 1,
    readContract,
    simulateBlocks,
    getBlock: async () => {
      const block = { number: 7n, baseFeePerGas: baseFee, timestamp: NOW }
      baseFee += baseFeeStep
      return block
    },
    estimateMaxPriorityFeePerGas: async () => PRIORITY_FEE,
  } as unknown as PublicClient
}

/** The wallet's tip for the release, paid in a token worth `usdPerToken`. */
function releaseTip(usdPerToken: bigint) {
  const usdPerEth = weiToUSD(WEI_PER_ETH, ETH_USD)
  const tokenWeiPerEth = (usdPerEth * ONE + usdPerToken - 1n) / usdPerToken
  const minPayout = gasCostAtQuotePrice(
    RELEASE_GAS_WITHOUT_ROUTE + ROUTE_GAS + 2n * UINT256_EXTRA_CALLDATA_GAS,
    { number: 7n, baseFeePerGas: BASE_FEE },
    FEES,
    tokenWeiPerEth,
  )
  return (minPayout * L1_OPERATION_TIP_MARGIN_BPS + 9_999n) / 10_000n
}

const quote = async (
  client: PublicClient,
  direction: "in" | "out",
  overrides: {
    amount?: bigint
    proverTip?: bigint
    bufferBps?: bigint
    tipsOnTop?: boolean
    recoveryMemo?: Buffer
  } = {},
) =>
  quoteMove(client, await readHoldingRoute(client, HOLDING_ADAPTERS, vaultHolding("DaiUsds")), {
    direction,
    amount: AMOUNT,
    eth: { feed: FEED },
    recoveryMemo: NO_MEMO,
    ...overrides,
  })

describe("RELEASE_GAS_WITHOUT_ROUTE", () => {
  /** Releases on a mainnet fork at the vendor pin: the gas spent, and the route's simulated gas. */
  const MEASURED = [
    { release: "None in", real: 378_631n, route: 238_215n },
    { release: "None out", real: 357_134n, route: 216_870n },
    { release: "Psm in", real: 754_951n, route: 613_592n },
    { release: "Psm out", real: 754_877n, route: 620_656n },
  ]

  it.each(MEASURED)(
    "prices the $release release at no less gas than it spent, and errs high by under 25,000",
    ({ real, route }) => {
      const quoted = RELEASE_GAS_WITHOUT_ROUTE + route
      expect(quoted).toBeGreaterThanOrEqual(real)
      expect(quoted - real).toBeLessThan(25_000n)
    },
  )
})

describe("quoteMove", () => {
  it("moving in, tips in DAI and buffers the shares below the current rate", async () => {
    const quoted = await quote(fakeChain(), "in", { proverTip: ONE })

    const relayerTip = releaseTip(ONE)
    const routed = AMOUNT - ONE - relayerTip
    const shares = (routed * ONE) / RATE
    expect(quoted).toMatchObject({
      relayerTip,
      routed,
      conversionOut: routed,
      expectedOut: shares,
      minOut: (shares * 9_990n) / 10_000n,
      routeGas: ROUTE_GAS,
      gasUsed: RELEASE_GAS_WITHOUT_ROUTE + ROUTE_GAS,
    })
  })

  it("moving out, tips in shares at the vault's rate and takes the current rate", async () => {
    const quoted = await quote(fakeChain(), "out")

    const relayerTip = releaseTip(RATE)
    const routed = AMOUNT - relayerTip
    expect(relayerTip).toBeLessThan(releaseTip(ONE))
    expect(quoted).toMatchObject({
      relayerTip,
      routed,
      expectedOut: (routed * RATE) / ONE,
      minOut: (routed * RATE) / ONE,
    })
  })

  it.each(["in", "out"] as const)(
    "with the tips on top, routes %s the whole amount while gas prices move between quotes",
    async (direction) => {
      const chain = fakeChain({ baseFeeStep: parseGwei("1") })
      const onTop = await quote(chain, direction, { proverTip: ONE, tipsOnTop: true })
      expect(onTop.routed).toBe(AMOUNT)
      expect(onTop.amount).toBe(AMOUNT + ONE + onTop.relayerTip)
      // Quoting that gross again prices a newer tip, so the route comes up short.
      const again = await quote(chain, direction, { proverTip: ONE, amount: onTop.amount })
      expect(again.routed).toBeLessThan(AMOUNT)
    },
  )

  it("floors a move into a vault with a deposit fee on the shares the deposit mints", async () => {
    const quoted = await quote(fakeChain({ depositFeeBps: 50n }), "in")
    const minted = (((quoted.routed * ONE) / RATE) * 9_950n) / BPS
    expect(quoted.expectedOut).toBe(minted)
    expect(quoted.minOut).toBeLessThanOrEqual(minted)
  })

  it("floors a move out of a vault with a redeem fee on the assets the redeem pays", async () => {
    const quoted = await quote(fakeChain({ redeemFeeBps: 50n }), "out")
    const paid = (((quoted.routed * RATE) / ONE) * 9_950n) / BPS
    expect(quoted.expectedOut).toBe(paid)
    expect(quoted.minOut).toBeLessThanOrEqual(paid)
  })

  it.each(["in", "out"] as const)(
    "quotes a move %s that fits what the vault takes once its tips are paid",
    async (direction) => {
      const room = await quote(fakeChain(), direction)
      const chain = fakeChain({ capacity: room.routed })
      const quoted = await quote(chain, direction)
      expect(quoted.routed).toBe(room.routed)
      expect(chain.routes.at(-1)).toBe(quoted.routed)
      expect(chain.routes.every((routed) => routed <= quoted.routed)).toBe(true)
      const over = fakeChain({ capacity: room.routed - 1n })
      await expect(quote(over, direction)).rejects.toMatchObject({ code: "move.routeUnread" })
    },
  )

  it("takes a buffer the caller gives", async () => {
    const quoted = await quote(fakeChain(), "out", { bufferBps: 50n })
    expect(quoted.minOut).toBe((quoted.expectedOut * 9_950n) / 10_000n)
    expect(() => bufferedMinOut(ONE, 10_000n)).toThrow(RangeError)
  })

  it("refuses an amount the tips use up", async () => {
    const tip = releaseTip(ONE)
    await expect(quote(fakeChain(), "in", { amount: tip })).rejects.toMatchObject({
      code: "move.tipsExceedAmount",
      data: { tips: tip.toString() },
    })
    await expect(quote(fakeChain(), "in", { proverTip: AMOUNT })).rejects.toMatchObject({
      code: "move.tipsExceedAmount",
      data: { tips: AMOUNT.toString() },
    })
  })

  it("reads a route that reverts as unread", async () => {
    await expect(quote(fakeChain({ reverts: true }), "in")).rejects.toMatchObject({
      code: "move.routeUnread",
    })
  })

  it("refuses a route whose recovery data a sponsored withdrawal cannot carry", async () => {
    await expect(
      quote(fakeChain(), "in", { recoveryMemo: Buffer.alloc(2_000) }),
    ).rejects.toMatchObject({ code: "move.routeTooLong" })
  })
})

describe("the route a quote simulates", () => {
  it("runs on the executor from the source portal, funded by state override", async () => {
    const seen: unknown[] = []
    const chain = fakeChain()
    const simulateBlocks = chain.simulateBlocks.bind(chain)
    Object.assign(chain, {
      simulateBlocks: async (args: unknown) => {
        seen.push(args)
        return simulateBlocks(args as never)
      },
    })
    await quote(chain, "out")
    const [{ blocks }] = seen as [
      { blocks: [{ calls: [{ to: Address }]; stateOverrides: [{ address: Address }] }] },
    ]
    expect([blocks[0].calls[0].to, blocks[0].stateOverrides[0].address]).toEqual([EXECUTOR, VAULT])
  })
})
