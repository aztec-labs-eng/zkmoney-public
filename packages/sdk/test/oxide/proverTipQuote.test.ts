import { describe, expect, it, vi } from "vitest"
import { ProverSubsidyAbi } from "@oxide/l1-contracts"
import { priceFeedForChainId } from "@oxide/oxide-client/eth_usd_price_feed.js"
import { submitEpochProofGas } from "@oxide/oxide-client/partial_epoch_proof_profit.js"
import type { PublicClient } from "viem"

import { PROVER_TIP_STEP, quoteWithdrawalProverTip } from "../../src/oxide/proverTipQuote.js"

const SUBSIDY = `0x${"22".repeat(20)}` as const
const NOW = 1_800_000_000n
const GWEI = 10n ** 9n
const USD_PER_ETH = 2_500n * 10n ** 8n

function client({
  gasPrice = 10n * GWEI,
  answer = USD_PER_ETH,
  updatedAt = NOW - 60n,
  subsidy = 0n,
}: { gasPrice?: bigint; answer?: bigint; updatedAt?: bigint; subsidy?: bigint } = {}) {
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) =>
    functionName === "latestRoundData" ? [1n, answer, 0n, updatedAt, 1n] : subsidy,
  )
  return {
    readContract,
    getGasPrice: vi.fn(async () => gasPrice),
    getBlock: vi.fn(async () => ({ timestamp: NOW })),
  }
}

const quote = (c: ReturnType<typeof client>, proverSubsidy?: `0x${string}`) =>
  quoteWithdrawalProverTip(c as unknown as PublicClient, { chainId: 1n, proverSubsidy })

// USD-18 of the proof's gas at 1.5x the read price, rounded up the way oxide's `weiToUSD` does.
const gasCost = (gasPrice: bigint, checkpointCount = 1n) => {
  const wei = submitEpochProofGas(checkpointCount) * ((gasPrice * 15_000n) / 10_000n)
  return (wei * USD_PER_ETH + 10n ** 8n - 1n) / 10n ** 8n
}
const toCents = (value: bigint) =>
  ((value + PROVER_TIP_STEP - 1n) / PROVER_TIP_STEP) * PROVER_TIP_STEP

describe("quoteWithdrawalProverTip", () => {
  it("prices the proof's gas at a buffered gas price and rounds up to a cent", async () => {
    const c = client()
    const result = await quote(c)

    expect(result).toEqual({
      proverTip: toCents(gasCost(10n * GWEI)),
      gasPriceWei: 10n * GWEI,
      usdPerEth: USD_PER_ETH,
      subsidy: 0n,
    })
    expect(result.proverTip % PROVER_TIP_STEP).toBe(0n)
    expect(result.proverTip).toBeGreaterThanOrEqual(gasCost(10n * GWEI))
  })

  it("quotes a later checkpoint higher: the proof's gas grows with each checkpoint it covers", async () => {
    const first = await quote(client())
    const later = await quoteWithdrawalProverTip(client() as unknown as PublicClient, {
      chainId: 1n,
      checkpointCount: 20n,
    })
    expect(later.proverTip).toBe(toCents(gasCost(10n * GWEI, 20n)))
    expect(later.proverTip).toBeGreaterThan(first.proverTip)
  })

  it("reads the chain's ETH/USD feed", async () => {
    const c = client()
    await quote(c)

    expect(c.readContract.mock.calls[0]![0]).toMatchObject({
      address: priceFeedForChainId(1n).toString(),
      functionName: "latestRoundData",
    })
  })

  it("subtracts the prover subsidy for one claim", async () => {
    const subsidy = 5n * 10n ** 18n
    const c = client({ gasPrice: 100n * GWEI, subsidy })
    const result = await quote(c, SUBSIDY)

    expect(c.readContract).toHaveBeenCalledWith({
      address: SUBSIDY,
      abi: ProverSubsidyAbi,
      functionName: "quoteSubsidy",
      args: [1n],
    })
    expect(result.subsidy).toBe(subsidy)
    expect(result.proverTip).toBe(toCents(gasCost(100n * GWEI) - subsidy))
  })

  it("quotes zero when the subsidy covers the proof", async () => {
    const result = await quote(client({ subsidy: 10n ** 21n }), SUBSIDY)
    expect(result.proverTip).toBe(0n)
  })

  it("reads no subsidy where the deployment has none", async () => {
    const c = client()
    await quote(c)
    expect(c.readContract.mock.calls.map(([call]) => call.functionName)).toEqual([
      "latestRoundData",
    ])
  })

  it("refuses a stale price feed", async () => {
    await expect(quote(client({ updatedAt: NOW - 2n * 60n * 60n }))).rejects.toThrow(/stale/)
  })
})
