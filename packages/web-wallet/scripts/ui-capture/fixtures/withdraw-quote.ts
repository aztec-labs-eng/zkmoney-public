import { memoryStore, type QueryState } from "@obsidion/front-core"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import { DEMO_WITHDRAWAL_FEE, DEMO_WITHDRAWAL_FEE_BENEFICIARY } from "../../../src/dev/fakeL1Rpc"
import * as actual from "../../../src/features/withdraw/withdrawQuote"
import { fixtureState, pause } from "./control"
export * from "../../../src/features/withdraw/withdrawQuote"
const RELAYER_TIP = 3n * 10n ** 18n
const simulate = async ({
  output,
  amountAtomic,
  proverTip = 0n,
}: actual.SwapArgs): Promise<actual.SwapQuote> => {
  const state = new URLSearchParams(location.search).get("quoteFixture") ?? "ready"
  if (!["ready", "loading", "unavailable", "amount-unavailable"].includes(state))
    throw new Error(`Unknown quote fixture: ${state}`)
  if (state === "loading") await new Promise<void>(() => {})
  await pause()
  // `amount-unavailable`: the route prices on the screen, but the simulation for the typed amount fails.
  if (state === "unavailable" || (state === "amount-unavailable" && amountAtomic !== undefined))
    throw new Error("Capture quote unavailable")
  const fee = {
    withdrawalFee: DEMO_WITHDRAWAL_FEE,
    feeBeneficiary: DEMO_WITHDRAWAL_FEE_BENEFICIARY,
    withdrawalRelayerTip: WITHDRAW_RELAYER_TIP,
    swapRelayerTip: RELAYER_TIP,
    proverTip,
    floorAtomic: DEMO_WITHDRAWAL_FEE + WITHDRAW_RELAYER_TIP + proverTip + RELAYER_TIP,
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
const executor = memoryStore<QueryState<actual.ExecutorTerms>>({
  status: "ready",
  value: { fee: DEMO_WITHDRAWAL_FEE, beneficiary: DEMO_WITHDRAWAL_FEE_BENEFICIARY },
  refreshing: false,
}).readonly
export const simulateSwapForTuple: typeof actual.simulateSwapForTuple = (args, tuple, page) =>
  fixtureState() ? simulate(args) : actual.simulateSwapForTuple(args, tuple, page)
// Priced on the demo's active deployment, so a capture reads no paylink's token.
export const useSwapSimulation: typeof actual.useSwapSimulation = (opts) =>
  actual.useSwapSimulation(fixtureState() ? { ...opts, sourceKey: "active", executor } : opts)
