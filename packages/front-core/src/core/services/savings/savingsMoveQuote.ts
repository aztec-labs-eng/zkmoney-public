import {
  assertExecutorServesPortal,
  quoteSkyEscrowTip,
  quoteSkyReleaseTip,
  readExecutorSubsidy,
  readWithdrawalExecutor,
  SkyTipExceedsFundingError,
  type WithdrawalExecutor,
  type WithdrawalExecutorKind,
} from "@obsidion/sdk"
import { SkyRoute } from "@oxide/experiments/sky/sky_savings.js"
import { erc4626Abi, type Address, type PublicClient } from "viem"
import {
  savingsSourceExecutor,
  tupleField,
  type SavingsDeployments,
  type SkyFactory,
} from "./savingsDeployment"
import type { SavingsDirection, SavingsQuote } from "./types"

/** The amount cannot pay the move's fees; `fee` is what they come to, in DAI. */
export class SavingsFeeError extends Error {
  constructor(readonly fee: bigint) {
    super("The amount does not cover the move's fees")
  }
}

export const savingsRoute = (direction: SavingsDirection): SkyRoute =>
  direction === "in" ? SkyRoute.Stake : SkyRoute.Unstake

/** Reads of an executor's immutables. A front passes session-cached ones; every quote reads them. */
export interface SavingsExecutorReads {
  executor(address: Address, kind: WithdrawalExecutorKind): Promise<WithdrawalExecutor>
  subsidy(address: Address): Promise<Address>
}

export interface SavingsQuoteDeps {
  client: PublicClient
  deployments: SavingsDeployments
  factory: SkyFactory
  /** Uncached reads through `client` when absent. */
  executorReads?: SavingsExecutorReads
}

export const directExecutorReads = (
  client: Pick<PublicClient, "readContract">,
): SavingsExecutorReads => ({
  executor: (address, kind) => readWithdrawalExecutor(client, address, kind),
  subsidy: (address) => readExecutorSubsidy(client, address),
})

/**
 * The source's withdrawal executor, checked to serve its portal. A move in releases through Main's plain executor,
 * which charges its fee in DAI; a move out through the Sky withdrawal executor, which charges none.
 */
export async function readSavingsExecutor(
  reads: SavingsExecutorReads,
  deployments: SavingsDeployments,
  direction: SavingsDirection,
): Promise<WithdrawalExecutor> {
  const source = direction === "in" ? deployments.main : deployments.savings
  const executor = await reads.executor(
    savingsSourceExecutor(deployments, direction),
    direction === "in" ? "plain" : "sky",
  )
  assertExecutorServesPortal(executor, tupleField(source, "portal"))
  return executor
}

/** The burn's value, the executor's fee, the subsidy its release claims and the tip the release offers. */
async function releaseLeg(deps: SavingsQuoteDeps, direction: SavingsDirection, amount: bigint) {
  const { client, factory } = deps
  const reads = deps.executorReads ?? directExecutorReads(client)
  const route = savingsRoute(direction)
  const toDai = (shares: bigint) =>
    client.readContract({
      address: factory.sUsds,
      abi: erc4626Abi,
      functionName: "convertToAssets",
      args: [shares],
    })
  const subsidy = reads.subsidy(savingsSourceExecutor(deps.deployments, direction))
  const [releaseTip, value, executor] = await Promise.all([
    subsidy
      .then((address) => quoteSkyReleaseTip(client, address, route))
      .then((release) => release.relayerTip),
    direction === "in" ? amount : toDai(amount),
    readSavingsExecutor(reads, deps.deployments, direction),
  ])
  return { route, releaseTip, value, executor, subsidy: await subsidy }
}

/**
 * Prices a move the way the escrow settles it: the executor's fee and the release tip come off the
 * burn and the escrow's run pays its tip.
 */
export async function quoteSavingsMove(
  deps: SavingsQuoteDeps,
  direction: SavingsDirection,
  amount: bigint,
): Promise<SavingsQuote> {
  const { client, factory } = deps
  const { main } = deps.deployments
  const { route, releaseTip, value, executor, subsidy } = await releaseLeg(deps, direction, amount)
  const withdrawalFee = executor.fee
  const released = withdrawalFee + releaseTip
  const escrowFunding = value - released
  if (escrowFunding <= 0n) throw new SavingsFeeError(released)
  const tip = await quoteSkyEscrowTip(
    client,
    {
      skyEscrowFactory: factory.address,
      operationExecutor: tupleField(main, "operationExecutor"),
      dai: factory.dai,
      withdrawalSubsidy: subsidy,
    },
    { route, escrowFunding, sender: factory.address },
  ).catch((err: unknown) => {
    if (err instanceof SkyTipExceedsFundingError)
      throw new SavingsFeeError(released + err.tip.relayerTip)
    throw err
  })
  const net = escrowFunding - tip.relayerTip
  if (net <= 0n) throw new SavingsFeeError(released + tip.relayerTip)
  return {
    direction,
    amount,
    unit: factory.dai,
    value,
    withdrawalFee,
    ...(executor.beneficiary ? { feeBeneficiary: executor.beneficiary } : {}),
    releaseTip,
    escrowTip: tip.relayerTip,
    escrowFunding,
    net,
    fee: value - net,
  }
}
