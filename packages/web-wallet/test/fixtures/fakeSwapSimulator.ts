/**
 * A stand-in for the sdk's `SwapOnWithdrawSimulator` with the same contract: a fixed tip, the typed
 * `SwapTipExceedsInputError` when the amount cannot cover it, and a payout off the sandbox mock rates.
 * Install it from a `vi.mock("@obsidion/sdk")` factory over the real module.
 */
import type { SwapSimulation, SwapSimulationArgs } from "@obsidion/sdk"

export interface FakeSwapControl {
  relayerTip: bigint
  /** Thrown by every simulation while set. */
  failure?: Error
  calls: SwapSimulationArgs[]
}

export function fakeSwapSimulator(sdk: typeof import("@obsidion/sdk"), control: FakeSwapControl) {
  return class FakeSwapOnWithdrawSimulator {
    async simulate(args: SwapSimulationArgs): Promise<SwapSimulation> {
      control.calls.push(args)
      if (control.failure) throw control.failure
      const { withdrawalRelayerTip, proverTip, fpcFundingCut } = args.deductions
      const funding = args.amount - withdrawalRelayerTip - proverTip - fpcFundingCut
      const tip = {
        relayerTip: control.relayerTip,
        breakEven: (control.relayerTip * 2n) / 3n,
        gasLimit: 300_000n,
        maxFeePerGas: 10n ** 9n,
        ethUsd: 3000n * 10n ** 8n,
      }
      if (funding <= control.relayerTip) throw new sdk.SwapTipExceedsInputError(tip, funding)
      const swapInput = funding - control.relayerTip
      return args.output === "ETH"
        ? { ...tip, amountOut: swapInput / 3000n, decimals: 18 }
        : { ...tip, amountOut: (swapInput * 99n) / 100n / 10n ** 12n, decimals: 6 }
    }
  }
}
