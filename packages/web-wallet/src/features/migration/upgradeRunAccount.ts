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

/** The read's value, null after a failed first read, undefined before one answers. */
const answered = <T>(state: QueryState<T | null>): T | null | undefined =>
  state.status === "failed" ? null : ready(state)

/**
 * What values an upgrade run in dollars: the token Main's deposits settle in, the pinned bridge's
 * underlying, the Savings asset and the share price. The pinned tuple holds through a manifest
 * refetch, so a value never drops out. The price names the Savings asset it was read on.
 */
export function upgradePricing({ config, chain }: PageFacts): ReadonlyStore<UpgradePricing> {
  return derived([chain.oxideTuple, chain.savingsPrice] as const, (tuple, read) => {
    const pinned = ready(tuple)
    const savings = answered(read)
    const tokens = {
      main: pinned && bridgeUnderlying(pinned),
      savings: savings?.holding.held.underlying,
    }
    return {
      mainToken: tokens.main,
      savingsToken: tokens.savings,
      sharePrice: savings?.sharePrice,
      runToken: (run: string) => upgradeRunToken(config, run, tokens),
      settled: tuple.status !== "pending" && savings !== undefined,
    }
  })
}
