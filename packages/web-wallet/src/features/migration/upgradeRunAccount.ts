import {
  chainUpgradeRun,
  derived,
  type QueryState,
  type ReadonlyStore,
  type UpgradePricing,
} from "@obsidion/front-core"
import { bridgeUnderlying } from "@obsidion/core/oxide"
import type { WebWalletConfig } from "../../config/env"
import type { PageFacts } from "../../session/pageChain"
import type { SavingsAccount } from "../savings/AccountSwitcher"
import { priceOf, type ChainSavingsPrice } from "../savings/savingsTasks"

/** The account a run pays into: `webMetadataMigrationKey` saves its destination portal as its second segment. */
export const upgradeRunAccount = (config: WebWalletConfig, run: string): SavingsAccount =>
  run.split("/")[1] === config.oxideProfile.portal.toLowerCase() ? "main" : "savings"

const inferredRun = chainUpgradeRun("")

/** The token a run credits: an inferred run (`chainUpgradeRun`) names it, else its account's. */
export const upgradeRunToken = (
  config: WebWalletConfig,
  run: string,
  tokens: { main?: string; savings?: string },
): string | undefined =>
  run.startsWith(inferredRun)
    ? run.slice(inferredRun.length)
    : tokens[upgradeRunAccount(config, run)]

const ready = <T>(state: QueryState<T>) => (state.status === "ready" ? state.value : undefined)

/**
 * What values an upgrade run in dollars: the token Main's deposits settle in, the pinned bridge's
 * underlying, the Savings asset and the share price. The pinned tuple holds through a manifest
 * refetch, so a value never drops out. The price names the Savings asset it was read on.
 */
export function upgradePricing(
  { config, chain }: PageFacts,
  price: ReadonlyStore<QueryState<ChainSavingsPrice | null>>,
): ReadonlyStore<UpgradePricing> {
  return derived([chain.oxideTuple, price] as const, (tuple, read) => {
    const pinned = ready(tuple)
    const savings = priceOf(read)
    const tokens = { main: pinned && bridgeUnderlying(pinned), savings: savings?.asset }
    return {
      mainToken: tokens.main,
      savingsToken: tokens.savings,
      sharePrice: savings?.sharePrice,
      runToken: (run: string) => upgradeRunToken(config, run, tokens),
      settled: tuple.status !== "pending" && savings !== undefined,
    }
  })
}
