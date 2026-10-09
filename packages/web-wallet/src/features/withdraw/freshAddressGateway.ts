/**
 * The fresh-address withdrawal: one sponsored burn to one pasted L1 address, which lands the funds
 * as the picked asset and a share of ETH for gas, so the address can spend without anyone funding
 * it. The burn pays one swap escrow: on the USDC, USDT and DAI routes the escrow swaps the gas share
 * to ETH (`daiForGas`) before its route, and on the ETH route the gas share is simply more ETH. DAI
 * with no gas share is a direct withdrawal. The burn is one withdrawal under the per-withdrawal
 * limit, gas share included.
 */
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { nextOperationId } from "@obsidion/sdk"
import type { WithdrawalRecord } from "@obsidion/front-core"
import type { Address } from "viem"
import { parseUnits } from "viem"
import { assertWithinWithdrawalLimit } from "../limits/withdrawalLimit"
import { runOperation } from "../operations/operations"
import type { WithdrawalReceiveAsset } from "./withdrawAssets"
import {
  burnContext,
  ownSwapRecoverer,
  planSwapLeg,
  runSponsoredBurn,
  type SwapCommit,
  type WithdrawDeps,
  type WithdrawStage,
} from "./withdrawGateway"

/** What the confirmed quote commits to: the escrow tip, the estimate the record keeps, and the route's floor. */
export interface FreshQuote extends SwapCommit {
  floorAtomic: bigint
  /** The burn's prover tip, inside `floorAtomic`. */
  proverTip?: bigint
}

export interface FreshWithdrawalInput {
  recipient: Address
  recipientAlias?: string
  /** What the recipient should receive, display units of the wallet asset: the funds and the gas share. */
  fundsDisplay: string
  gasDisplay: string
  /** What the funds land as; the gas share always lands as ETH. */
  fundsAsset: WithdrawalReceiveAsset
  quote: FreshQuote
}

/** The DAI the escrow swaps to ETH for gas. The ETH route already pays ETH, so its gas share rides the route. */
export function freshDaiForGas(fundsAsset: WithdrawalReceiveAsset, gasAtomic: bigint): bigint {
  return fundsAsset === "ETH" ? 0n : gasAtomic
}

/** What the burn removes: the funds and the gas share the recipient should receive, plus the route's floor. */
export function freshBurnAmount(
  fundsDisplay: string,
  gasDisplay: string,
  floorAtomic: bigint,
): bigint {
  return (
    parseUnits(fundsDisplay, DEFAULT_DECIMALS) +
    parseUnits(gasDisplay, DEFAULT_DECIMALS) +
    floorAtomic
  )
}

/** The burn as one operation, checked against the limit before it is screened or signed. */
export async function submitFreshAddressWithdrawal(
  deps: WithdrawDeps,
  input: FreshWithdrawalInput,
  onStage: (stage: WithdrawStage) => void,
): Promise<WithdrawalRecord> {
  const { recipient, recipientAlias, fundsAsset, quote } = input
  const amount = freshBurnAmount(input.fundsDisplay, input.gasDisplay, quote.floorAtomic)
  const daiForGas = freshDaiForGas(fundsAsset, parseUnits(input.gasDisplay, DEFAULT_DECIMALS))
  const summary = `$${input.fundsDisplay} to ${recipientAlias?.trim() || "Ethereum"}`
  const operation = { operationId: nextOperationId("withdraw"), flow: "withdraw" as const, summary }
  const { record } = await runOperation(operation, async (op) => {
    onStage("building")
    assertWithinWithdrawalLimit(amount)
    const ctx = await burnContext(deps, recipient)
    const { proverTip = 0n } = quote
    const swap = await planSwapLeg(
      deps.wallet,
      fundsAsset,
      recipient,
      amount,
      quote,
      await ownSwapRecoverer(ctx.tuple),
      ctx.tuple,
      proverTip,
      daiForGas,
    )
    const burn = { recipient, recipientAlias, amount, swap, swapCommit: swap && quote, proverTip }
    return runSponsoredBurn(op, deps, ctx, burn, onStage)
  })
  return record
}
