import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  quoteSkyEscrowTip,
  quoteSkyReleaseTip,
  readFpcFundingCut,
  SkyTipExceedsFundingError,
} from "@obsidion/sdk"
import { SkyEscrowFactoryAbi, SkyRoute } from "@oxide/experiments/sky/sky_savings.js"
import { erc4626Abi, type Address, type PublicClient } from "viem"
import type { SavingsDirection, SavingsQuote } from "./types"

/** Main is the DAI deployment; Savings the sUSDS one. Both sit in the one oxide manifest. */
export interface SavingsDeployments {
  main: OxideEnvTuple
  savings: OxideEnvTuple
}

export interface SkyFactory {
  address: Address
  dai: Address
  sUsds: Address
}

/** The amount cannot pay the move's fees; `fee` is what they come to, in DAI. */
export class SavingsFeeError extends Error {
  constructor(readonly fee: bigint) {
    super("The amount does not cover the move's fees")
  }
}

export const tupleField = (tuple: OxideEnvTuple, field: keyof OxideEnvTuple): Address => {
  const value = tuple[field]
  if (typeof value !== "string" || !value) throw new Error(`oxide manifest lacks ${field}`)
  return value as Address
}

export const savingsRoute = (direction: SavingsDirection): SkyRoute =>
  direction === "in" ? SkyRoute.Stake : SkyRoute.Unstake

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The two portals a Sky escrow factory's escrows deposit into: DAI's for a move out, sUSDS's for a move in. */
export async function readSkyFactoryPortals(
  client: Pick<PublicClient, "readContract">,
  factory: Address,
): Promise<{ daiPortal: Address; sUsdsPortal: Address }> {
  const read = (functionName: "DAI_PORTAL" | "SUSDS_PORTAL") =>
    client.readContract({
      address: factory,
      abi: SkyEscrowFactoryAbi,
      functionName,
    }) as Promise<Address>
  const [daiPortal, sUsdsPortal] = await Promise.all([read("DAI_PORTAL"), read("SUSDS_PORTAL")])
  return { daiPortal, sUsdsPortal }
}

/** The Sky escrow factory the manifest names, checked to move between these two deployments. */
export async function resolveSkyFactory(
  client: Pick<PublicClient, "readContract">,
  { main, savings }: SavingsDeployments,
): Promise<SkyFactory> {
  const address = (main.skyEscrowFactory || savings.skyEscrowFactory) as Address | undefined
  if (!address) throw new Error("The oxide manifest names no Sky escrow factory")
  const read = (functionName: "DAI" | "SUSDS") =>
    client.readContract({ address, abi: SkyEscrowFactoryAbi, functionName }) as Promise<Address>
  const [dai, sUsds, { daiPortal, sUsdsPortal }] = await Promise.all([
    read("DAI"),
    read("SUSDS"),
    readSkyFactoryPortals(client, address),
  ])
  if (!sameAddress(daiPortal, main.portal) || !sameAddress(sUsdsPortal, savings.portal)) {
    throw new Error(
      `The Sky escrow factory ${address} moves between ${daiPortal} and ${sUsdsPortal}, not this wallet's deployments`,
    )
  }
  return { address, dai, sUsds }
}

export interface SavingsQuoteDeps {
  client: PublicClient
  deployments: SavingsDeployments
  factory: SkyFactory
  /** A portal's `FPC_FUNDING_CUT`; fronts cache it per portal. */
  cutOf?: (portal: Address) => Promise<bigint>
}

/** The burn's value and what reaches its escrow: the burn less the source portal's cut and the release tip. */
async function releaseLeg(deps: SavingsQuoteDeps, direction: SavingsDirection, amount: bigint) {
  const { client, factory } = deps
  const { main, savings } = deps.deployments
  const [source, destination] = direction === "in" ? [main, savings] : [savings, main]
  const cutOf = deps.cutOf ?? ((portal: Address) => readFpcFundingCut(client, portal))
  const route = savingsRoute(direction)
  const toDai = (shares: bigint) =>
    client.readContract({
      address: factory.sUsds,
      abi: erc4626Abi,
      functionName: "convertToAssets",
      args: [shares],
    })
  const [sourceCut, arrivalCut, releaseTip] = await Promise.all([
    cutOf(tupleField(source, "portal")),
    cutOf(tupleField(destination, "portal")),
    quoteSkyReleaseTip(client, tupleField(source, "withdrawalSubsidy"), route).then(
      (release) => release.relayerTip,
    ),
  ])
  const value = direction === "in" ? amount : await toDai(amount)
  const released = direction === "in" ? amount - sourceCut : await toDai(amount - sourceCut)
  return { source, route, sourceCut, arrivalCut, releaseTip, value, released }
}

/**
 * Prices a move the way the escrow settles it: the source portal's cut and the release tip come off
 * the burn, the escrow's run pays its tip, and the destination portal takes its cut on the deposit.
 */
export async function quoteSavingsMove(
  deps: SavingsQuoteDeps,
  direction: SavingsDirection,
  amount: bigint,
): Promise<SavingsQuote> {
  const { client, factory } = deps
  const { main } = deps.deployments
  const { source, route, sourceCut, arrivalCut, releaseTip, value, released } = await releaseLeg(
    deps,
    direction,
    amount,
  )
  const escrowFunding = released - releaseTip
  const feeBefore = value - released + releaseTip
  if (escrowFunding <= 0n) throw new SavingsFeeError(feeBefore + arrivalCut)
  const tip = await quoteSkyEscrowTip(
    client,
    {
      skyEscrowFactory: factory.address,
      operationExecutor: tupleField(main, "operationExecutor"),
      dai: factory.dai,
      withdrawalSubsidy: tupleField(source, "withdrawalSubsidy"),
    },
    { route, escrowFunding, sender: factory.address },
  ).catch((err: unknown) => {
    if (err instanceof SkyTipExceedsFundingError)
      throw new SavingsFeeError(feeBefore + err.tip.relayerTip + arrivalCut)
    throw err
  })
  const net = escrowFunding - tip.relayerTip - arrivalCut
  if (net <= 0n) throw new SavingsFeeError(feeBefore + tip.relayerTip + arrivalCut)
  return {
    direction,
    amount,
    value,
    releaseTip,
    sourceCut,
    escrowTip: tip.relayerTip,
    arrivalCut,
    escrowFunding,
    net,
    fee: value - net,
  }
}
