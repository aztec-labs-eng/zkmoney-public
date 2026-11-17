// A swap: one withdrawal that moves a vault's shares into another vault. The source's steps out
// run first, then the destination's steps in, on the executor both vaults share.
import { WalletError } from "@obsidion/core/errors"
import { adapters, withdrawalRoute } from "@oxide/l1-contracts/multi_step/index.js"
import type { LaneBuilder, Step } from "@oxide/l1-contracts/multi_step/index.js"
import { isAddressEqual } from "viem"
import type { Hex } from "viem"
import type { HoldingRoute } from "./holdingDeployment.js"
import { SIZING_MOVE, routeWithdrawal } from "./moveRoute.js"
import type { BuiltMove, CompiledMove, MoveArgs } from "./moveRoute.js"

/** A swap's floors, one per step that returns a token. */
export interface VaultSwapFloors {
  /** The least the source's redeem returns, in its vault's asset. */
  redeemMinOut: bigint
  /** The least the source's conversion returns, in the base's token; 0 on a direct swap. */
  baseMinOut: bigint
  /**
   * The least the destination's deposit takes in, in its vault's asset: what its conversion
   * returns, or on a direct swap what the redeem returns.
   */
  assetMinOut: bigint
  /** The least the destination's deposit mints, in its shares: the floor of what lands. */
  minOut: bigint
}

export interface VaultSwapRouteArgs extends VaultSwapFloors {
  /** Opens to the account that claims the deposit at the destination's held portal. */
  recipientCommitment: Hex
}

/**
 * Whether the two vaults hold one asset, so the redeem's asset goes straight into the deposit and
 * both conversions are skipped.
 */
export const isDirectVaultSwap = (from: HoldingRoute, to: HoldingRoute): boolean =>
  isAddressEqual(from.deployment.held.asset, to.deployment.held.asset)

/** Throws `move.routeMismatch` unless one executor on one chain can run both vaults' steps. */
function assertVaultSwappable(from: HoldingRoute, to: HoldingRoute): void {
  const [a, b] = [from.deployment, to.deployment]
  const refuse = (why: string): never => {
    throw new WalletError("move.routeMismatch", `the vaults cannot swap: ${why}`)
  }
  if (a.chainId !== b.chainId) refuse("they are on different chains")
  if (!isAddressEqual(a.executor, b.executor)) refuse("they run on different executors")
  if (isAddressEqual(a.held.portal, b.held.portal)) refuse("they are one vault")
  if (!isDirectVaultSwap(from, to) && !isAddressEqual(a.base.token, b.base.token))
    refuse("their bases hold different tokens")
}

/**
 * A swap's route: the source's shares, less the relayer tip, redeemed, converted to the base's
 * token and on to the destination vault's asset, deposited into the destination vault, and its
 * shares deposited into the destination's held portal. Both conversions are skipped when the vaults
 * share an asset. Throws as oxide's builders do, and `move.routeMismatch` for two vaults no one
 * route joins.
 */
export function compileVaultSwap(
  from: HoldingRoute,
  to: HoldingRoute,
  args: VaultSwapRouteArgs,
): CompiledMove {
  assertVaultSwappable(from, to)
  const direct = isDirectVaultSwap(from, to)
  const { portalDeposit } = adapters({
    chainId: to.deployment.chainId,
    configs: { portalDeposit: { address: to.deployment.portalDepositAdapter } },
  })
  const steps = [
    ...from.terms.steps("out", args.redeemMinOut),
    ...(direct ? [] : from.conversion.steps("out", args.baseMinOut)),
    ...(direct ? [] : to.conversion.steps("in", args.assetMinOut)),
    ...to.terms.steps("in", args.minOut),
  ]
  const { held } = to.deployment
  const end = portalDeposit.deposit({
    portal: { address: held.portal, asset: held.token },
    recipientCommitment: args.recipientCommitment,
  })
  const route = withdrawalRoute({ token: from.deployment.held.token }).remainder((lane) =>
    steps.reduce((built: LaneBuilder, step: Step) => built.step(step), lane).end(end),
  )
  const calls = [...steps, end].map((step) => ({ target: step.adapter, call: step.fn }))
  return { route, calls }
}

export type VaultSwapArgs = VaultSwapRouteArgs &
  Omit<MoveArgs, "direction" | "minOut" | "conversionMinOut">

/**
 * The withdrawal of a swap: a burn of the source's shares that pays the executor. Throws as
 * `compileVaultSwap` does, and `move.routeTooLong` when its recovery data takes more than a move's.
 */
export function buildVaultSwap(
  from: HoldingRoute,
  to: HoldingRoute,
  args: VaultSwapArgs,
): BuiltMove {
  return routeWithdrawal(from.deployment.executor, compileVaultSwap(from, to, args), args)
}

/** Floors no amount falls below, which size a swap and never revert its route. */
export const SIZING_FLOORS: VaultSwapFloors = {
  redeemMinOut: 1n,
  baseMinOut: 1n,
  assetMinOut: 1n,
  minOut: 1n,
}

/** Throws as `buildVaultSwap` does when a swap from `from` into `to` with `recoveryMemo` cannot. */
export function assertVaultSwapFits(
  from: HoldingRoute,
  to: HoldingRoute,
  recoveryMemo: Buffer,
): void {
  buildVaultSwap(from, to, { ...SIZING_MOVE, ...SIZING_FLOORS, recoveryMemo })
}
