import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import * as actual from "../../../src/features/withdraw/withdrawQuote"
import { DEMO_FPC_FUNDING_CUT } from "../../../src/dev/fakeL1Rpc"
import { fixtureState, pause } from "./control"
export * from "../../../src/features/withdraw/withdrawQuote"
const RELAYER_TIP = 3n * 10n ** 18n
const simulate: actual.SimulateSwap = async ({ output, amountAtomic }) => {
  const state = new URLSearchParams(location.search).get("quoteFixture") ?? "ready"
  if (!["ready", "loading", "unavailable"].includes(state))
    throw new Error(`Unknown quote fixture: ${state}`)
  if (state === "loading") await new Promise<void>(() => {})
  await pause()
  if (state === "unavailable") throw new Error("Capture quote unavailable")
  const fee = {
    withdrawalRelayerTip: WITHDRAW_RELAYER_TIP,
    swapRelayerTip: RELAYER_TIP,
    fpcFundingCut: DEMO_FPC_FUNDING_CUT,
    floorAtomic: WITHDRAW_RELAYER_TIP + DEMO_FPC_FUNDING_CUT + RELAYER_TIP,
  }
  if (amountAtomic === undefined || amountAtomic <= fee.floorAtomic) return { fee }
  const swapInput = amountAtomic - fee.floorAtomic
  return {
    fee,
    estimate:
      output === "ETH"
        ? { amountOut: swapInput / 2500n, decimals: 18 }
        : { amountOut: swapInput / 10n ** 12n, decimals: 6 },
  }
}
export const useSwapSimulation: typeof actual.useSwapSimulation = (opts) =>
  actual.useSwapSimulation(fixtureState() ? { ...opts, simulate } : opts)
