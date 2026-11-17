/**
 * Prices a swap as `quoteMove` prices a move: one relayer tip, in the source's shares, and a floor
 * for each step that returns a token, read down the route from what the tip leaves. The simulated
 * route, held to those floors, is what says the swap runs.
 */
import { WalletError } from "@obsidion/core/errors"
import { checkedMultiStepRemainder } from "@oxide/oxide-client/executors/multi_step_withdrawal.js"
import type { RelayerTipEstimate } from "../tip/l1OperationQuote.js"
import type { EthUsdSource } from "../tip/tipQuote.js"
import type { HoldingRoute } from "./holdingDeployment.js"
import {
  MOVE_BUFFER_BPS,
  SIMULATION_COMMITMENT,
  bufferedMinOut,
  routeTip,
  simulateExecutorRoute,
  tipsExceedAmount,
  vaultShareTipPrice,
} from "./moveQuote.js"
import type { QuoteClient } from "./moveQuote.js"
import { MOVE_FEE_POOL_CUT } from "./moveRoute.js"
import {
  SIZING_FLOORS,
  assertVaultSwapFits,
  compileVaultSwap,
  isDirectVaultSwap,
} from "./vaultSwapRoute.js"
import type { VaultSwapFloors } from "./vaultSwapRoute.js"

export interface VaultSwapQuote extends VaultSwapFloors, RelayerTipEstimate {
  /** The burn, in the source's shares. */
  amount: bigint
  /** What the route keeps: the amount less the tip. */
  routed: bigint
  /** What the destination vault takes in at the current rates, in its asset. */
  assetOut: bigint
  /** What the destination vault mints at the current rates. */
  expectedOut: bigint
  /** Gas the simulated route used, within `gasUsed`. */
  routeGas: bigint
}

/** The floors for `routed` of the source's shares, and what the destination takes and mints now. */
async function readVaultSwapTerms(
  from: HoldingRoute,
  to: HoldingRoute,
  routed: bigint,
): Promise<VaultSwapFloors & { assetOut: bigint; expectedOut: bigint }> {
  const redeemOut = await from.terms.reader.previewRedeem(routed)
  const redeemMinOut = bufferedMinOut(redeemOut, MOVE_BUFFER_BPS.out)
  const deposit = async (assetOut: bigint, assetMinOut: bigint) => {
    const [expectedOut, least] = await Promise.all([
      to.terms.reader.previewDeposit(assetOut),
      to.terms.reader.previewDeposit(assetMinOut),
    ])
    return { assetOut, assetMinOut, expectedOut, minOut: bufferedMinOut(least, MOVE_BUFFER_BPS.in) }
  }
  if (isDirectVaultSwap(from, to)) {
    return { redeemMinOut, baseMinOut: 0n, ...(await deposit(redeemOut, redeemMinOut)) }
  }
  const base = await from.conversion.quote("out", redeemMinOut)
  const [asset, floor] = await Promise.all([
    to.conversion.quote("in", base.out),
    to.conversion.quote("in", base.minOut),
  ])
  return { redeemMinOut, baseMinOut: base.minOut, ...(await deposit(asset.out, floor.minOut)) }
}

/**
 * Quotes a swap of `amount` of `from`'s shares into `to`. Throws `move.routeMismatch` for two
 * vaults no route joins, `move.routeTooLong` when the route cannot fit `recoveryMemo`,
 * `move.tipsExceedAmount` when the tip leaves nothing, and `move.routeUnread` when a read fails or
 * the simulated route reverts.
 */
export async function quoteVaultSwap(
  client: QuoteClient,
  from: HoldingRoute,
  to: HoldingRoute,
  args: {
    amount: bigint
    eth: EthUsdSource
    /** The memo the burn will carry, which sizes its recovery data. */
    recoveryMemo: Buffer
  },
): Promise<VaultSwapQuote> {
  const { amount } = args
  if (amount <= 0n) throw tipsExceedAmount(amount, 0n)
  assertVaultSwapFits(from, to, args.recoveryMemo)
  const source = { portal: from.deployment.held.portal, token: from.deployment.held.token }
  const simulate = (floors: VaultSwapFloors, run: { executed: bigint; relayerTip: bigint }) =>
    simulateExecutorRoute(
      client,
      from.deployment,
      source,
      compileVaultSwap(from, to, { ...floors, recipientCommitment: SIMULATION_COMMITMENT }).route,
      run,
    )
  try {
    // The route's gas does not depend on its amount: half of it is an amount the route gets.
    const tip = await routeTip(client, args.eth, await vaultShareTipPrice(client, from), () =>
      simulate(SIZING_FLOORS, { executed: amount / 2n + 1n, relayerTip: 1n }),
    )
    const { relayerTip } = tip
    if (amount <= relayerTip) throw tipsExceedAmount(amount, relayerTip)
    const routed = checkedMultiStepRemainder({
      amount,
      proverTip: 0n,
      relayerTip,
      feePoolCut: MOVE_FEE_POOL_CUT.amount,
      fixed: [],
    })
    const { assetOut, expectedOut, ...floors } = await readVaultSwapTerms(from, to, routed)
    // The route as the release runs it, held to its floors.
    await simulate(floors, { executed: amount, relayerTip })
    return {
      ...floors,
      amount,
      routed,
      assetOut,
      expectedOut,
      ...tip,
    }
  } catch (error) {
    if (error instanceof WalletError) throw error
    throw new WalletError("move.routeUnread", String(error), { cause: error })
  }
}
