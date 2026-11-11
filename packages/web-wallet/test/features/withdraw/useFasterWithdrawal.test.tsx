/** One faster-withdrawal quote: where this device's burn lands, and the tip for its checkpoint. */
import { describe, expect, it, vi } from "vitest"
import {
  createBurnDurations,
  fixed,
  memoryBackend,
  openDatabase,
  type WithdrawalSpeedupEstimate,
} from "@obsidion/front-core"
import type { ProverTipQuote } from "@obsidion/sdk"
import { answered } from "../../support/query"

const PROVER_SUBSIDY = `0x${"33".repeat(20)}`
const sdkQuote = vi.hoisted(() => vi.fn())
const estimate = vi.hoisted(() => vi.fn())
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  quoteWithdrawalProverTip: sdkQuote,
}))
vi.mock("../../../src/config/oxideTuple", () => ({ l1PublicClient: () => ({}) }))

const { DEFAULT_BURN_LANDING } = await import("../../../src/features/withdraw/burnTiming")
const { loadFasterWithdrawal } = await import("../../../src/features/withdraw/useFasterWithdrawal")

const TIP = 42n * 10n ** 16n
const speedup = (speedupSeconds: number): WithdrawalSpeedupEstimate => ({
  epoch: 10 as WithdrawalSpeedupEstimate["epoch"],
  checkpointIndex: 3,
  standardEtaSeconds: 2_700,
  tippedEtaSeconds: 2_700 - speedupSeconds,
  worstSpeedupSeconds: speedupSeconds,
  speedupSeconds,
  confidence: "measured",
  pastTipCutoff: false,
})
const tipQuote = (proverTip: bigint): ProverTipQuote => ({
  proverTip,
  gasPriceWei: 10n ** 9n,
  usdPerEth: 2_500n * 10n ** 8n,
  subsidy: 0n,
})

describe("loadFasterWithdrawal", () => {
  it("estimates the burn's landing and quotes the tip for its checkpoint and the deployment's subsidy", async () => {
    estimate.mockResolvedValue(speedup(1_200))
    sdkQuote.mockResolvedValue(tipQuote(TIP))

    const result = await loadFasterWithdrawal(
      createBurnDurations({ db: openDatabase(memoryBackend()) }),
      {
        config: { network: "mainnet", l1ChainId: 1 },
        chain: { oxideTuple: answered({ proverSubsidy: PROVER_SUBSIDY }) },
        speedupEstimator: fixed("speedupEstimator", { estimate }),
      } as never,
      new AbortController().signal,
    )

    expect(estimate).toHaveBeenCalledWith(DEFAULT_BURN_LANDING)
    expect(sdkQuote).toHaveBeenCalledWith(expect.anything(), {
      chainId: 1n,
      proverSubsidy: PROVER_SUBSIDY,
      checkpointCount: 3n,
    })
    expect(result.quote.proverTip).toBe(TIP)
  })
})
