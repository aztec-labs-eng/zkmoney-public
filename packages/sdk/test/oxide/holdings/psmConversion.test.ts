import { describe, expect, it } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { Step } from "@oxide/l1-contracts/multi_step/index.js"
import { decodeFunctionData, getAddress } from "viem"
import type { Address, Hex, PublicClient } from "viem"
import { UniswapV3AdapterAbi } from "@oxide/l1-contracts/artifacts.js"
import { mappingSlot } from "../../../src/oxide/escrow/swapOnWithdrawSimulator.js"
import { HOLDING_ADAPTERS } from "../../../src/oxide/holdings/adapters.js"
import { readHoldingRoute } from "../../../src/oxide/holdings/holdingDeployment.js"
import { EXIT_BUFFER_BPS, PSM_MAINNET } from "../../../src/oxide/holdings/conversions/psm.js"
import { MOVE_RECOVERY_CHUNKS, buildMove } from "../../../src/oxide/holdings/moveRoute.js"
import { vaultShareTipPrice } from "../../../src/oxide/holdings/moveQuote.js"
import { encodeWithdrawalMemo } from "../../../src/services/withdrawal/withdrawalMemo.js"
import {
  DAI,
  MAKER_PSM_ADAPTER,
  UNISWAP_V3_ADAPTER,
  USDC,
  VAULT,
  vaultHolding,
} from "./holdingFixtures.js"

const PSM = getAddress(PSM_MAINNET.litePsm)
const SCALE = 10n ** 12n
const BALANCE_SLOT = 0n
/** USDC per whole share. */
const USDC_RATE = 1_050_000n
const ONE = 10n ** 18n

interface Call {
  to: Address
  data?: Hex
  functionName?: string
}

/**
 * A LitePSM of `gem`, and simulations whose step pays `pays(step's adapter, amount in)` to a
 * recipient that already holds `prefunded`.
 */
function fakeChain(
  pays: (adapter: Address, amount: bigint) => bigint,
  gem: Address = USDC,
  prefunded = 0n,
) {
  const simulated: Call[][] = []
  const client = {
    getChainId: async () => 1,
    getBlock: async () => ({}),
    readContract: async ({ address, functionName, args = [], stateOverride }: never) => {
      const [arg] = args as [bigint & Address]
      if (address === PSM) return { dai: DAI, gem, to18ConversionFactor: SCALE }[functionName]
      switch (functionName) {
        case "asset":
          return USDC
        case "decimals":
          return address === USDC ? 6 : 18
        case "convertToAssets":
          return (arg * USDC_RATE) / ONE
        case "balanceOf": {
          const wanted = mappingSlot(arg, BALANCE_SLOT)
          const diff = (stateOverride as { stateDiff: { slot: Hex; value: Hex }[] }[])?.[0]
            ?.stateDiff
          const hit = diff?.find((entry) => entry.slot === wanted)
          return hit ? BigInt(hit.value) : 0n
        }
        default:
          throw new Error(`unexpected ${functionName} on ${address}`)
      }
    },
    simulateBlocks: async ({ blocks: [block] }: never) => {
      const { calls, stateOverrides } = block as {
        calls: Call[]
        stateOverrides: [{ stateDiff: [{ value: Hex }] }]
      }
      simulated.push(calls)
      const amount = BigInt(stateOverrides[0].stateDiff[0].value)
      let held = prefunded
      return [
        {
          calls: calls.map((call) => {
            if (call.functionName === "balanceOf") return { status: "success", result: held }
            held += pays(call.to, amount)
            return { status: "success" }
          }),
        },
      ]
    },
  }
  return { client: client as unknown as PublicClient, simulated }
}

const atPsm = (adapter: Address, amount: bigint) =>
  adapter === MAKER_PSM_ADAPTER ? amount / SCALE : (amount * SCALE * 9_998n) / 10_000n

const shape = (steps: Step[]) => steps.map((step) => [step.adapter, step.fn, step.in, step.out])

const bind = (client: PublicClient) =>
  readHoldingRoute(client, HOLDING_ADAPTERS, vaultHolding("Psm"))

describe("the Psm conversion", () => {
  it("buys USDC at the PSM moving in and swaps it back on Uniswap V3 moving out", async () => {
    const { conversion } = await bind(fakeChain(atPsm).client)
    expect({
      in: shape(conversion.steps("in", 1n)),
      out: shape(conversion.steps("out", 1n)),
    }).toEqual({
      in: [[MAKER_PSM_ADAPTER, "psmBuyGem", DAI, USDC]],
      out: [[UNISWAP_V3_ADAPTER, "uniswapV3ExactIn", USDC, DAI]],
    })
    const [swap] = conversion.steps("out", 1n)
    const { args } = decodeFunctionData({
      abi: UniswapV3AdapterAbi,
      data: swap!.encode({ amount: 1n, recipient: VAULT }),
    })
    expect((args[0] as Hex).toLowerCase()).toBe(
      `${USDC}${PSM_MAINNET.exitPoolFee.toString(16).padStart(6, "0")}${DAI.slice(
        2,
      )}`.toLowerCase(),
    )
  })

  it("quotes each leg from a simulation of its step, in the six-decimal gem's units", async () => {
    const { client, simulated } = fakeChain(atPsm)
    const { conversion } = await bind(client)
    const amountIn = 20n * ONE
    expect(await conversion.quote("in", amountIn)).toEqual({
      out: 20_000_000n,
      fee: 0n,
      minOut: 20_000_000n,
    })
    const out = (20_000_000n * SCALE * 9_998n) / 10_000n
    expect(await conversion.quote("out", 20_000_000n)).toEqual({
      out,
      fee: (20_000_000n * SCALE - out) / SCALE,
      minOut: (out * (10_000n - EXIT_BUFFER_BPS)) / 10_000n,
    })
    const steps = simulated.map((calls) => calls.find((call) => !call.functionName)!.to)
    expect(steps).toEqual([MAKER_PSM_ADAPTER, UNISWAP_V3_ADAPTER])
  })

  it("quotes only what the step pays to a recipient someone already funded", async () => {
    const { conversion } = await bind(fakeChain(atPsm, USDC, 5_000_000n).client)
    expect(await conversion.quote("in", 20n * ONE)).toMatchObject({ out: 20_000_000n })
  })

  it("refuses a PSM that swaps other tokens than the holding's", async () => {
    await expect(bind(fakeChain(atPsm, DAI).client)).rejects.toMatchObject({
      code: "move.routeMismatch",
    })
  })

  it("reads a step that reverts as an unread route", async () => {
    const { client } = fakeChain(atPsm)
    Object.assign(client, {
      simulateBlocks: async () => [
        { calls: [{ status: "failure", error: new Error("MakerPsmAdapter__InsufficientOutput") }] },
      ],
    })
    const { conversion } = await bind(client)
    await expect(conversion.quote("in", ONE)).rejects.toMatchObject({ code: "move.routeUnread" })
  })

  it("prices a share tip from the six-decimal asset's rate", async () => {
    const route = await bind(fakeChain(atPsm).client)
    expect(await vaultShareTipPrice(fakeChain(atPsm).client, route)).toEqual({
      kind: "fixed",
      price: { usdPerToken: USDC_RATE * SCALE, decimals: 18 },
    })
  })

  it.each(["in", "out"] as const)(
    "builds a move %s within the six-chunk budget",
    async (direction) => {
      const built = buildMove(await bind(fakeChain(atPsm).client), {
        direction,
        minOut: 1n,
        conversionMinOut: 1n,
        recipientCommitment: `0x${"01".repeat(32)}`,
        from: AztecAddress.fromNumberUnsafe(2),
        amount: ONE,
        proverTip: 0n,
        relayerTip: 1n,
        recovery: { salt: new Fr(3n), account: `0x${"0a".repeat(20)}` },
        recoveryMemo: encodeWithdrawalMemo({ vaultMove: { nonce: `0x${"aa".repeat(32)}` } }),
      })
      expect(built.recoveryChunks).toBeLessThanOrEqual(MOVE_RECOVERY_CHUNKS)
    },
  )
})
