import { WalletError } from "@obsidion/core/errors"
import { adapters } from "@oxide/l1-contracts/multi_step/index.js"
import { getAddress, isAddressEqual, parseAbi } from "viem"
import type { Address } from "viem"
import { quoteStep } from "../conversion.js"
import type { ConversionAdapter } from "../conversion.js"
import { executorAdapter } from "../holdingDeployment.js"
import { bufferedMinOut } from "../moveQuote.js"

/**
 * The mainnet contracts the `Psm` conversion runs through that no feature publishes: Maker's
 * DAI–USDC LitePSM, and the fee of the Uniswap V3 USDC–DAI pool the exit swaps through (0.01%).
 */
export const PSM_MAINNET = {
  litePsm: "0xf6e72Db5454dd049d0788e411b06CfAF16853042",
  exitPoolFee: 100,
} as const satisfies { litePsm: Address; exitPoolFee: number }

/** The swap back runs after the proof lands, hours after its quote. */
export const EXIT_BUFFER_BPS = 50n

const psmAbi = parseAbi([
  "function dai() view returns (address)",
  "function gem() view returns (address)",
  "function to18ConversionFactor() view returns (uint256)",
])

/**
 * A vault of the PSM's gem from a DAI base. In: the PSM sells the gem for DAI at its `tout`. Out:
 * the gem swaps back to DAI through Uniswap V3. Each leg is quoted by simulating its step.
 */
export const psmConversion: ConversionAdapter = {
  kind: "Psm",
  async bind(client, deployment, executor) {
    const address = getAddress(PSM_MAINNET.litePsm)
    const read = <F extends "dai" | "gem" | "to18ConversionFactor">(functionName: F) =>
      client.readContract({ address, abi: psmAbi, functionName })
    const [stable, gem, scale] = await Promise.all([
      read("dai"),
      read("gem"),
      read("to18ConversionFactor"),
    ])
    if (!isAddressEqual(stable, deployment.base.token) || !isAddressEqual(gem, deployment.held.asset)) {
      throw new WalletError(
        "move.routeMismatch",
        `the PSM ${address} swaps ${stable} and ${gem}, not the holding's tokens`,
      )
    }
    const { makerPsm, uniswapV3 } = adapters({
      chainId: deployment.chainId,
      configs: {
        makerPsm: { address: executorAdapter(executor, "makerPsm") },
        uniswapV3: { address: executorAdapter(executor, "uniswapV3") },
      },
    })
    const psm = { address, stable, gem }
    const path = { tokenIn: gem, hops: [{ fee: PSM_MAINNET.exitPoolFee, tokenOut: stable }] } as const
    const legs = {
      in: (minOut: bigint) => [makerPsm.buyGem({ psm, minOut })],
      out: (minOut: bigint) => [uniswapV3.exactIn({ path, minOut })],
    }
    const quotes = {
      // The PSM sells exactly what the simulation bought, so the floor is the quote.
      async in(amount: bigint) {
        const out = await quoteStep(client, makerPsm.buyGem({ psm, minOut: 0n }), amount)
        return { out, fee: amount - out * scale, minOut: out }
      },
      async out(amount: bigint) {
        const out = await quoteStep(client, uniswapV3.exactIn({ path, minOut: 0n }), amount)
        const fee = amount * scale - out
        return { out, fee: fee > 0n ? fee / scale : 0n, minOut: bufferedMinOut(out, EXIT_BUFFER_BPS) }
      },
    }
    return {
      steps: (direction, minOut) => legs[direction](minOut),
      quote: (direction, amount) => quotes[direction](amount),
    }
  },
}
