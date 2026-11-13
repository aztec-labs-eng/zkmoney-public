// A vault's move runs on its deployment's `MultiStepExecutor`: one withdrawal whose user payload
// routes the funds through the executor's adapters into the other bridge's portal.
import type { ExecutorHolding, MultiStepExecutor } from "@obsidion/core/oxide"
import { WalletError } from "@obsidion/core/errors"
import type { MultiStepPayload } from "@oxide/l1-contracts/multi_step/index.js"
import { erc4626Abi, getAddress, isAddressEqual } from "viem"
import type { Address, PublicClient } from "viem"
import type { HoldingAdapters } from "./adapters.js"
import { bindConversion } from "./conversion.js"
import type { BoundConversion } from "./conversion.js"
import { bindTerms } from "./terms.js"
import type { BoundTerms } from "./terms.js"

/** The L1 addresses a move of one vault routes through. */
export interface HoldingDeployment {
  chainId: bigint
  executor: Address
  portalDepositAdapter: Address
  /** The base's portal and its token: where moves come from and go back to. */
  base: { portal: Address; token: Address }
  /** The vault's portal, its share token, and the vault's asset. */
  held: { portal: Address; token: Address; asset: Address }
}

/** The executor's adapter of `kind`, which the holding's catalog entry guarantees. */
export function executorAdapter(executor: MultiStepExecutor, kind: string): Address {
  const address = executor.adapters[kind]
  if (address === undefined) {
    throw new WalletError("invariant", `${executor.id} has no ${kind} adapter`)
  }
  return getAddress(address)
}

/** `holding`'s deployment on chain `chainId`, whose vault takes and pays `asset`. */
export function holdingDeployment(
  holding: ExecutorHolding,
  chainId: bigint,
  asset: Address,
): HoldingDeployment {
  const { executor, base, held } = holding
  return {
    chainId,
    executor: getAddress(executor.address),
    portalDepositAdapter: executorAdapter(executor, "portalDeposit"),
    base: { portal: getAddress(base.portal), token: getAddress(base.underlying) },
    held: {
      portal: getAddress(held.portal),
      token: getAddress(held.underlying),
      asset: getAddress(asset),
    },
  }
}

/** Reads the chain and the vault's asset, the two facts of a deployment the manifest leaves out. */
export async function readHoldingDeployment(
  client: Pick<PublicClient, "getChainId" | "readContract">,
  holding: ExecutorHolding,
): Promise<HoldingDeployment> {
  const [chainId, asset] = await Promise.all([
    client.getChainId(),
    client.readContract({
      address: getAddress(holding.held.underlying),
      abi: erc4626Abi,
      functionName: "asset",
    }),
  ])
  return holdingDeployment(holding, BigInt(chainId), asset)
}

/**
 * Throws `move.routeMismatch` unless the withdrawal pays the manifest's executor and its route pays
 * and calls only the executor's adapters, so a stale or foreign deployment never receives a move.
 */
export function assertRouteOnExecutor(
  withdrawal: { executor: Address; payload: MultiStepPayload },
  executor: MultiStepExecutor,
): void {
  if (!isAddressEqual(withdrawal.executor, getAddress(executor.address))) {
    throw new WalletError(
      "move.routeMismatch",
      `the route runs on ${withdrawal.executor}, not ${executor.address}`,
    )
  }
  const adapters = Object.values(executor.adapters).map((a) => getAddress(a))
  const { payload } = withdrawal
  const paid = [
    payload.remainderRecipient,
    ...payload.transfers.map((transfer) => transfer.recipient),
    ...payload.steps.map((step) => step.target),
  ]
  const stranger = paid.find((address) => !adapters.some((a) => isAddressEqual(a, address)))
  if (stranger) {
    throw new WalletError("move.routeMismatch", `the route pays ${stranger}, not an adapter`)
  }
}

/** A vault's deployment, with its terms and conversion bound to the executor's adapters. */
export interface HoldingRoute {
  deployment: HoldingDeployment
  terms: BoundTerms
  conversion: BoundConversion
}

/**
 * Reads `holding`'s deployment and binds its terms and conversion through `adapters`. Throws
 * `holding.unsupported` when neither routes it, and `move.routeUnread` when a read fails.
 */
export async function readHoldingRoute(
  client: Pick<PublicClient, "getChainId" | "readContract" | "getBlock" | "simulateBlocks">,
  adapters: HoldingAdapters,
  holding: ExecutorHolding,
): Promise<HoldingRoute> {
  try {
    const deployment = await readHoldingDeployment(client, holding)
    const terms = bindTerms(adapters.terms, client, holding, deployment)
    const conversion = await bindConversion(adapters.conversions, client, holding, deployment)
    return { deployment, terms, conversion }
  } catch (error) {
    if (error instanceof WalletError) throw error
    throw new WalletError("move.routeUnread", `${holding.id}: ${String(error)}`, { cause: error })
  }
}
