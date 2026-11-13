import type { DeploymentHoldings } from "@obsidion/core/oxide"
import {
  memoryStore,
  type HoldingPrice,
  savingsHolding,
  useAfter,
  useStore,
  type After,
  type QueryState,
} from "@obsidion/front-core"
import { useCallback, useMemo } from "react"
import { useSession } from "../../session/session"
import { selectHoldingPrices, selectSavingsListed, type SavingsLine } from "./savingsLine"

/** The Savings surfaces show after the first balance. */
const SHOWN_AFTER: After = { firstBalance: true }

/**
 * The session's Savings for a view: its line, valued at the vault's price, and whether Savings
 * shows. It shows once the first balance is in, where the account has a Sky line.
 */
export function useSavings(): SavingsLine & { available: boolean } {
  const { milestones, savingsLine } = useSession()
  const shown = useAfter(milestones, SHOWN_AFTER)
  const line = useStore(savingsLine)
  return { available: shown && !!line.line, ...line }
}

const NO_HOLDINGS = memoryStore<QueryState<never>>({ status: "pending" }).readonly

const skyAsset = (listed: readonly string[] | undefined) => (s: QueryState<DeploymentHoldings>) =>
  s.status === "ready" ? savingsHolding(s.value, listed)?.held.underlying ?? null : undefined

/** The Savings asset once the deployment is read; null where it has none; pending for a visitor. */
export function useSavingsAsset(): string | null | undefined {
  const { moveCommands, page } = useSession()
  return useStore(moveCommands ? page.chain.holdings : NO_HOLDINGS, skyAsset(page.config.holdings))
}

/** Whether the nav offers Savings: the wallet lists a Sky holding, or the account has a Sky line. */
export function useSavingsAvailable(): boolean {
  const { page, savingsLine } = useSession()
  const listed = useStore(page.chain.holdings, (s) => selectSavingsListed(s, page.config.holdings))
  const held = useStore(savingsLine, (s) => !!s.line)
  return listed || held
}

/** Each holding's price by id; a visitor has none. */
export function useHoldingPrices(): ReadonlyMap<string, HoldingPrice> {
  const { moveCommands, page } = useSession()
  const holdings = useStore(moveCommands ? page.chain.holdings : NO_HOLDINGS)
  const prices = useStore(moveCommands ? page.chain.savingsPrices : NO_HOLDINGS)
  return useMemo(() => selectHoldingPrices(holdings, prices), [holdings, prices])
}

/** Values a move's shares at its own holding's share price; a visitor has none. */
export function useMoveSharePrice(): (holdingId: string) => bigint | undefined {
  const prices = useHoldingPrices()
  return useCallback((holdingId) => prices.get(holdingId)?.sharePrice, [prices])
}
