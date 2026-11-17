import { describe, expect, it } from "vitest"
import { ETH_USD_FEED_DECIMALS } from "@oxide/oxide-client/eth_usd_price_feed.js"
import { MultiStepExecutorAbi } from "@oxide/l1-contracts/artifacts.js"
import { decodeMultiStepPayload } from "@oxide/l1-contracts/multi_step/index.js"
import type { ConversionKind, ExecutorHolding } from "@obsidion/core/oxide"
import { decodeFunctionData, getAddress, hexToBytes, parseGwei } from "viem"
import type { Address, Hex, PublicClient, StateOverride } from "viem"
import { mappingSlot } from "../../../src/oxide/escrow/swapOnWithdrawSimulator.js"
import { HOLDING_ADAPTERS } from "../../../src/oxide/holdings/adapters.js"
import { readHoldingRoute } from "../../../src/oxide/holdings/holdingDeployment.js"
import { quoteMove } from "../../../src/oxide/holdings/moveQuote.js"
import { quoteVaultSwap } from "../../../src/oxide/holdings/vaultSwapQuote.js"
import { DAI, SKY_CONVERTER_ADAPTER, USDS, vaultHolding } from "./holdingFixtures.js"

const address = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`)
const VAULT_A = address(0x7a0a)
const VAULT_B = address(0x7a0b)
const FEED = address(0xfeed)
const ONE = 10n ** 18n
const BPS = 10_000n
/** A's assets per share; B's are one for one. */
const RATE_A = (110n * ONE) / 100n
const BALANCE_SLOT = 2n
const AMOUNT = 1_000n * ONE
const MEMO = Buffer.alloc(0)

const holding = (kind: ConversionKind, vault: Address, portal: number): ExecutorHolding => {
  const base = vaultHolding(kind)
  return {
    ...base,
    held: { ...base.held, underlying: vault, token: vault, portal: address(portal) },
  }
}

/** What the simulated `execute` routes: its amount less the relayer tip it pays. */
function routedBy(data: Hex): bigint {
  const { args } = decodeFunctionData({ abi: MultiStepExecutorAbi, data })
  if (args.length !== 4) throw new Error("not the executor's execute")
  const [, amount, payload] = args
  return amount - decodeMultiStepPayload(Buffer.from(hexToBytes(payload))).relayerTip
}

/**
 * Two vaults, B of `assetB`, and a route that reverts once it routes more than `capacity`.
 */
function fakeChain({ assetB = DAI, capacity = undefined as bigint | undefined } = {}) {
  const routes: bigint[] = []
  const readContract = async ({
    address: at,
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
    if (at === SKY_CONVERTER_ADAPTER) return functionName === "DAI" ? DAI : USDS
    const rate = at === VAULT_A ? RATE_A : ONE
    switch (functionName) {
      case "latestRoundData":
        return [0n, 3000n * 10n ** ETH_USD_FEED_DECIMALS, 0n, 1_800_000_000n, 0n]
      case "decimals":
        return 18
      case "asset":
        return at === VAULT_A ? DAI : assetB
      case "balanceOf": {
        const wanted = mappingSlot(arg, BALANCE_SLOT)
        const hit = stateOverride?.[0]?.stateDiff?.find((entry) => entry.slot === wanted)
        return hit ? BigInt(hit.value) : 0n
      }
      case "previewDeposit":
        return (arg * ONE) / rate
      case "previewRedeem":
      case "convertToAssets":
        return (arg * rate) / ONE
      default:
        throw new Error(`unexpected read ${functionName} on ${at}`)
    }
  }
  const simulateBlocks = async ({ blocks: [block] }: { blocks: [{ calls: [{ data: Hex }] }] }) => {
    const routed = routedBy(block.calls[0].data)
    routes.push(routed)
    const full = capacity !== undefined && routed > capacity
    return [
      {
        calls: [
          full
            ? { status: "failure", error: new Error("ERC4626Adapter__InsufficientOutput") }
            : { status: "success", gasUsed: 400_000n },
        ],
      },
    ]
  }
  return {
    routes,
    getChainId: async () => 1,
    readContract,
    simulateBlocks,
    getBlock: async () => ({ number: 7n, baseFeePerGas: parseGwei("10"), timestamp: 1n }),
    estimateMaxPriorityFeePerGas: async () => parseGwei("1"),
  } as unknown as PublicClient & { routes: bigint[] }
}

async function routes(client: PublicClient, b: ConversionKind = "None") {
  return {
    from: await readHoldingRoute(client, HOLDING_ADAPTERS, holding("None", VAULT_A, 0x900a)),
    to: await readHoldingRoute(client, HOLDING_ADAPTERS, holding(b, VAULT_B, 0x900b)),
  }
}

const quote = async (client: PublicClient, b: ConversionKind = "None", recoveryMemo = MEMO) => {
  const { from, to } = await routes(client, b)
  return quoteVaultSwap(client, from, to, { amount: AMOUNT, eth: { feed: FEED }, recoveryMemo })
}

describe("quoteVaultSwap", () => {
  it("tips in the source's shares as a move out does, and floors each step on what the tip leaves", async () => {
    const client = fakeChain()
    const quoted = await quote(client)
    const { from } = await routes(client)
    const out = await quoteMove(client, from, {
      direction: "out",
      amount: AMOUNT,
      eth: { feed: FEED },
      recoveryMemo: MEMO,
    })
    expect(quoted.relayerTip).toBe(out.relayerTip)
    const routed = AMOUNT - quoted.relayerTip
    const redeemed = (routed * RATE_A) / ONE
    expect(quoted).toMatchObject({
      amount: AMOUNT,
      routed,
      redeemMinOut: redeemed,
      // One asset: the redeem's asset goes straight into the deposit.
      baseMinOut: 0n,
      assetOut: redeemed,
      assetMinOut: redeemed,
      expectedOut: redeemed,
      minOut: (redeemed * 9_990n) / BPS,
    })
    expect(client.routes.at(-1)).toBe(routed)
  })

  it("floors both conversions between vaults of different assets", async () => {
    const quoted = await quote(fakeChain({ assetB: USDS }), "DaiUsds")
    const redeemed = ((AMOUNT - quoted.relayerTip) * RATE_A) / ONE
    // Sky's converter swaps DAI and USDS one for one.
    expect(quoted).toMatchObject({
      redeemMinOut: redeemed,
      baseMinOut: redeemed,
      assetMinOut: redeemed,
      minOut: (redeemed * 9_990n) / BPS,
    })
  })

  it("quotes a swap whose route runs, and refuses one whose route reverts", async () => {
    const room = await quote(fakeChain())
    expect((await quote(fakeChain({ capacity: room.routed }))).routed).toBe(room.routed)
    await expect(quote(fakeChain({ capacity: room.routed - 1n }))).rejects.toMatchObject({
      code: "move.routeUnread",
    })
  })

  it("refuses a swap whose recovery data outgrows a sponsored withdrawal before it reads L1", async () => {
    const client = fakeChain()
    await expect(quote(client, "None", Buffer.alloc(2_000))).rejects.toMatchObject({
      code: "move.routeTooLong",
    })
    expect(client.routes).toEqual([])
  })

  it("refuses an amount the tip takes all of, and none before it reads L1", async () => {
    const client = fakeChain()
    const { from, to } = await routes(client)
    const quoting = (amount: bigint) =>
      quoteVaultSwap(client, from, to, { amount, eth: { feed: FEED }, recoveryMemo: MEMO })
    await expect(quoting(0n)).rejects.toMatchObject({ code: "move.tipsExceedAmount" })
    expect(client.routes).toEqual([])
    await expect(quoting(1n)).rejects.toMatchObject({ code: "move.tipsExceedAmount" })
  })
})
