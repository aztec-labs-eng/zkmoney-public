// How a vault's share token takes and returns its asset. Each terms kind is one module under
// `terms/`, and the caller's map is the one registry, as conversions are.
import type { ExecutorHolding, MultiStepExecutor, TermsKind } from "@obsidion/core/oxide"
import { WalletError } from "@obsidion/core/errors"
import type { Step } from "@oxide/l1-contracts/multi_step/index.js"
import type { Address, PublicClient } from "viem"
import type { MoveDirection } from "./conversion.js"
import type { HoldingDeployment } from "./holdingDeployment.js"

export type TermsClient = Pick<PublicClient, "readContract">

/** The reads a move prices its terms step with. */
export interface TermsReader {
  maxDeposit(receiver: Address): Promise<bigint>
  maxRedeem(owner: Address): Promise<bigint>
  /** The shares a deposit of `assets` mints now, after any fee the vault takes. */
  previewDeposit(assets: bigint): Promise<bigint>
  /** The assets a redeem of `shares` pays now, after any fee the vault takes. */
  previewRedeem(shares: bigint): Promise<bigint>
  /** What `shares` are worth now, before fees: a balance's value, never a floor. */
  convertToAssets(shares: bigint): Promise<bigint>
}

/** A vault's terms on one deployment's adapters. */
export interface BoundTerms {
  reader: TermsReader
  /** The step into the share token moving in, out of it moving out; it returns `minOut` or more. */
  steps(direction: MoveDirection, minOut: bigint): Step[]
}

export interface TermsAdapter {
  readonly kind: TermsKind
  bind(client: TermsClient, deployment: HoldingDeployment, executor: MultiStepExecutor): BoundTerms
}

export type TermsAdapters = Partial<Record<TermsKind, TermsAdapter>>

/** The map a caller resolves vaults' terms through. */
export const termsAdapters = (...adapters: TermsAdapter[]): TermsAdapters =>
  Object.fromEntries(adapters.map((adapter) => [adapter.kind, adapter]))

/** `holding`'s terms, bound to its executor's adapters. Throws `holding.unsupported` when none. */
export function bindTerms(
  terms: TermsAdapters,
  client: TermsClient,
  holding: ExecutorHolding,
  deployment: HoldingDeployment,
): BoundTerms {
  const adapter = terms[holding.terms]
  if (!adapter) {
    throw new WalletError(
      "holding.unsupported",
      `${holding.id}: terms ${holding.terms} have no implementation`,
    )
  }
  return adapter.bind(client, deployment, holding.executor)
}
