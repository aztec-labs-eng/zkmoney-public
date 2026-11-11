/**
 * The fresh-address withdrawal: one sponsored burn to one pasted L1 address, which lands the funds
 * as the picked asset and a share of ETH for gas, so the address can spend without anyone funding
 * it. The burn pays one swap escrow: on the USDC, USDT and DAI routes the escrow swaps the gas share
 * to ETH (`daiForGas`) before its route, and on the ETH route the gas share is simply more ETH. DAI
 * with no gas share is a direct withdrawal. The burn is one withdrawal under the per-withdrawal
 * limit, gas share included.
 */
import { nextOperationId } from "@obsidion/sdk"
import type { WithdrawalRecord } from "@obsidion/front-core"
import type { Address } from "viem"
import { formatUnits } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { assertWithinWithdrawalLimit } from "../limits/withdrawalLimit"
import { runOperation } from "../operations/operations"
import { usdBalance } from "../../ui/format"
import type { WithdrawalReceiveAsset } from "./withdrawAssets"
import {
  burnContext,
  sessionSwapRecoverer,
  planSwapLeg,
  runSponsoredBurn,
  type SwapCommit,
  type WithdrawDeps,
  type WithdrawStage,
} from "./withdrawGateway"
import { accountKitOf } from "../../session/session"

/** What the confirmed quote commits to: the escrow tip, the estimate the record keeps, and the route's floor. */
export interface FreshQuote extends SwapCommit {
  floorAtomic: bigint
  /** The burn's prover tip, inside `floorAtomic`. */
  proverTip?: bigint
}

export interface FreshWithdrawalInput {
  recipient: Address
  recipientAlias?: string
  /** From, in DAI base units: what leaves before the gas share, fees inside it. */
  amountAtomic: bigint
  /** The whole burn: From, the gas share and what the gas adds to the fee. */
  burnAtomic: bigint
  /** The share the escrow lands as ETH. */
  gasAtomic: bigint
  /** What the funds land as; the gas share always lands as ETH. */
  fundsAsset: WithdrawalReceiveAsset
  quote: FreshQuote
}

/** The DAI the escrow swaps to ETH for gas. The ETH route already pays ETH, so its gas share rides the route. */
export function freshDaiForGas(fundsAsset: WithdrawalReceiveAsset, gasAtomic: bigint): bigint {
  return fundsAsset === "ETH" ? 0n : gasAtomic
}

/** The burn as one operation, checked against the limit before it is screened or signed. */
export async function submitFreshAddressWithdrawal(
  deps: WithdrawDeps,
  input: FreshWithdrawalInput,
  onStage: (stage: WithdrawStage) => void,
): Promise<WithdrawalRecord> {
  const { recipient, recipientAlias, fundsAsset, quote } = input
  const kit = { ...deps, ...(await accountKitOf(deps.session)) }
  const amount = input.burnAtomic
  const daiForGas = freshDaiForGas(fundsAsset, input.gasAtomic)
  const funds = usdBalance(formatUnits(input.amountAtomic, DEFAULT_DECIMALS))
  const summary = `${funds} to ${recipientAlias?.trim() || "Ethereum"}`
  const operation = { operationId: nextOperationId("withdraw"), flow: "withdraw" as const, summary }
  const { record } = await runOperation(deps.session, operation, async (op) => {
    onStage("building")
    assertWithinWithdrawalLimit(amount, await deps.session.page.chain.currentTxAmountCap.read())
    const ctx = await burnContext(kit, recipient)
    const { proverTip = 0n } = quote
    const recoverer = await sessionSwapRecoverer(deps.session, ctx.tuple)
    const swap = await planSwapLeg(
      deps.session.page.chain,
      async () => recoverer,
      fundsAsset,
      recipient,
      amount,
      quote,
      ctx.tuple,
      proverTip,
      daiForGas,
    )
    const burn = { recipient, recipientAlias, amount, swap, swapCommit: swap && quote, proverTip }
    return runSponsoredBurn(op, kit, ctx, burn, onStage)
  })
  return record
}
