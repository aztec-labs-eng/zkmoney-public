/**
 * The prover tip that makes an oxide prover post a partial-epoch proof covering one withdrawal early. Oxide's
 * `quoteProverTip` is the relayer's own rule; this module reads its L1 inputs the way the relayer does and
 * quotes at a buffered gas price, since the relayer decides minutes after the burn.
 */
import { ProverSubsidyAbi } from "@oxide/l1-contracts"
import { priceFeedForChainId, readUsdPerEth } from "@oxide/oxide-client/eth_usd_price_feed.js"
import { quoteProverTip } from "@oxide/oxide-client/partial_epoch_proof_profit.js"
import type { Address, PublicClient } from "viem"
import { PROVER_TIP_GAS_PRICE_BUFFER_BPS } from "@obsidion/core/constants"

/** Tips are rounded up to this step: one cent of the 18-dec token. */
export const PROVER_TIP_STEP = 10n ** 16n

export interface ProverTipQuote {
  /** 18-dec token units, a whole number of cents. */
  proverTip: bigint
  /** The L1 gas price read now. The tip is quoted at it times `PROVER_TIP_GAS_PRICE_BUFFER_BPS`. */
  gasPriceWei: bigint
  /** ETH/USD feed answer, 8 decimals. */
  usdPerEth: bigint
  /** `ProverSubsidy.quoteSubsidy(1)`; zero where the deployment has no prover subsidy. */
  subsidy: bigint
}

export async function quoteWithdrawalProverTip(
  client: PublicClient,
  args: {
    chainId: bigint
    proverSubsidy?: Address
    /** Checkpoints the partial proof covers: the burn's index in its epoch. */
    checkpointCount?: bigint
  },
): Promise<ProverTipQuote> {
  const [gasPriceWei, usdPerEth, subsidy] = await Promise.all([
    client.getGasPrice(),
    readUsdPerEth(client, priceFeedForChainId(args.chainId)),
    args.proverSubsidy
      ? client.readContract({
          address: args.proverSubsidy,
          abi: ProverSubsidyAbi,
          functionName: "quoteSubsidy",
          args: [1n],
        })
      : Promise.resolve(0n),
  ])
  const tip = quoteProverTip({
    gasPriceWei: (gasPriceWei * PROVER_TIP_GAS_PRICE_BUFFER_BPS) / 10_000n,
    usdPerEth,
    subsidyForOneClaim: subsidy,
    checkpointCount: args.checkpointCount ?? 1n,
  })
  return {
    proverTip: ((tip + PROVER_TIP_STEP - 1n) / PROVER_TIP_STEP) * PROVER_TIP_STEP,
    gasPriceWei,
    usdPerEth,
    subsidy: subsidy,
  }
}
