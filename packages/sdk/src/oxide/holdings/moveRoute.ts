import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { WalletError } from "@obsidion/core/errors"
import {
  adapters,
  decodeMultiStepPayload,
  withdrawalRoute,
} from "@oxide/l1-contracts/multi_step/index.js"
import type {
  CompiledRoute,
  LaneBuilder,
  MultiStepPayload,
  Step,
} from "@oxide/l1-contracts/multi_step/index.js"
import { buildMultiStepWithdrawal } from "@oxide/oxide-client/executors/multi_step_withdrawal.js"
import type { FeePoolCut } from "@oxide/oxide-client/executors/multi_step_withdrawal.js"
import type { WithdrawOperation } from "@oxide/oxide-client/l2_operations.js"
import { zeroHash } from "viem"
import type { Address, Hex } from "viem"
import { MAX_WITHDRAWAL_RECOVERY_CHUNKS } from "../../feePaymentMethod/claimFpc/gas/claimFpcGasModel.js"
import { withdrawalRecoveryChunks } from "../withdrawal/plainWithdrawal.js"
import type { MoveDirection } from "./conversion.js"
import type { HoldingDeployment, HoldingRoute } from "./holdingDeployment.js"

export interface MoveRouteArgs {
  direction: MoveDirection
  /** The least the terms step may return: shares moving in, the vault's asset moving out. */
  minOut: bigint
  /** The least the conversion may return: the vault's asset moving in, the base's token moving out. */
  conversionMinOut: bigint
  /** Opens to the account that claims the deposit at the destination portal. */
  recipientCommitment: Hex
}

/** A bridge end of a move: its portal and the token it holds. */
export interface MoveEnd {
  portal: Address
  token: Address
}

/** The bridge a move withdraws from and the one it deposits into. */
export function moveEnds(
  deployment: Pick<HoldingDeployment, "base" | "held">,
  direction: MoveDirection,
): { source: MoveEnd; destination: MoveEnd } {
  const { base } = deployment
  const held = { portal: deployment.held.portal, token: deployment.held.token }
  return direction === "in"
    ? { source: base, destination: held }
    : { source: held, destination: base }
}

/** One call of a route: the adapter it runs on and the adapter function. */
export interface MoveStep {
  target: Address
  call: string
}

export interface CompiledMove {
  route: CompiledRoute
  /** Its calls, in order. */
  calls: MoveStep[]
}

/**
 * A move's route: everything the executor keeps after the relayer tip, in one lane, converted and
 * run through the terms step into the destination portal. Throws as oxide's builders do, on a step
 * that takes the wrong token or an unbounded terms step.
 */
export function compileMove(
  { deployment, conversion, terms }: HoldingRoute,
  args: MoveRouteArgs,
): CompiledMove {
  const { portalDeposit } = adapters({
    chainId: deployment.chainId,
    configs: { portalDeposit: { address: deployment.portalDepositAdapter } },
  })
  const { direction, minOut, conversionMinOut, recipientCommitment } = args
  const { source, destination } = moveEnds(deployment, direction)
  const steps =
    direction === "in"
      ? [...conversion.steps("in", conversionMinOut), ...terms.steps("in", minOut)]
      : [...terms.steps("out", minOut), ...conversion.steps("out", conversionMinOut)]
  const end = portalDeposit.deposit({
    portal: { address: destination.portal, asset: destination.token },
    recipientCommitment,
  })
  const route = withdrawalRoute({ token: source.token }).remainder((lane) =>
    steps.reduce((built: LaneBuilder, step: Step) => built.step(step), lane).end(end),
  )
  const calls = [...steps, end].map((step) => ({ target: step.adapter, call: step.fn }))
  return { route, calls }
}

/** The recovery chunks a move's withdrawal may take: what a sponsored `withdraw` is budgeted at. */
export const MOVE_RECOVERY_CHUNKS = MAX_WITHDRAWAL_RECOVERY_CHUNKS

/** The base's bridge takes no fee pool cut of a move. */
export const MOVE_FEE_POOL_CUT: FeePoolCut = { amount: 0n, beneficiary: EthAddress.ZERO }

export interface MoveArgs extends MoveRouteArgs {
  from: AztecAddress
  amount: bigint
  proverTip: bigint
  /** In the withdrawn token. */
  relayerTip: bigint
  /** Who may take the move back with `MultiStepExecutor.recover` while its route reverts. */
  recovery: { salt: Fr; account: Address }
  /** What a fresh device rebuilds the move from; carried in the burn's recovery data. */
  recoveryMemo: Buffer
}

export interface BuiltMove {
  /** Pays the deployment's `MultiStepExecutor`. */
  operation: WithdrawOperation
  payload: MultiStepPayload
  calls: MoveStep[]
  /** The recovery chunks the burn emits. */
  recoveryChunks: number
}

/**
 * The withdrawal of a move. Throws when the tips leave the route nothing, and `move.routeTooLong`
 * when its recovery data takes more than {@link MOVE_RECOVERY_CHUNKS}.
 */
export function buildMove(route: HoldingRoute, args: MoveArgs): BuiltMove {
  const { route: compiled, calls } = compileMove(route, args)
  const { operation } = buildMultiStepWithdrawal({
    from: args.from,
    executor: EthAddress.fromString(route.deployment.executor),
    amount: args.amount,
    proverTip: args.proverTip,
    relayerTip: args.relayerTip,
    feePoolCut: MOVE_FEE_POOL_CUT,
    compiledRoute: compiled,
    recoveryAccount: EthAddress.fromString(args.recovery.account),
    recoverySalt: args.recovery.salt,
    recoveryMemo: args.recoveryMemo,
  })
  const recoveryChunks = withdrawalRecoveryChunks(operation)
  if (recoveryChunks > MOVE_RECOVERY_CHUNKS) {
    throw new WalletError(
      "move.routeTooLong",
      `the route's recovery data takes ${recoveryChunks} chunks, over ${MOVE_RECOVERY_CHUNKS}`,
    )
  }
  const payload = decodeMultiStepPayload(operation.userPayload)
  return { operation, payload, calls, recoveryChunks }
}

/** Every field of a move is fixed-width, so any amounts and secrets size its recovery data. */
const SIZING_MOVE = {
  from: AztecAddress.ZERO,
  amount: 1n,
  proverTip: 0n,
  relayerTip: 0n,
  minOut: 1n,
  conversionMinOut: 1n,
  recipientCommitment: zeroHash,
  recovery: { salt: Fr.ZERO, account: "0x0000000000000000000000000000000000000001" },
} as const

/** Throws `move.routeTooLong` when a move in `direction` with `recoveryMemo` cannot fit. */
export function assertMoveFits(
  route: HoldingRoute,
  direction: MoveDirection,
  recoveryMemo: Buffer,
): void {
  buildMove(route, { ...SIZING_MOVE, direction, recoveryMemo })
}
