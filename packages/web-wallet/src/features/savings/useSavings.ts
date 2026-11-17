import {
  memoryStore,
  type HoldingPrice,
  useAfter,
  useStore,
  type After,
  type QueryState,
} from "@obsidion/front-core"
import { useMemo } from "react"
import { useSession } from "../../session/session"
import {
  selectHoldingPrices,
  selectSavingsListed,
  selectSavingsTokens,
  type SavingsLine,
} from "./savingsLine"

/** The Savings surfaces show after the first balance. */
const SHOWN_AFTER: After = { firstBalance: true }

/**
 * The session's Savings for a view: its lines, each valued at its vault's price, and whether
 * Savings shows. It shows once the first balance is in, where the account has a line.
 */
export function useSavings(): SavingsLine & { available: boolean } {
  const { milestones, savingsLine } = useSession()
  const shown = useAfter(milestones, SHOWN_AFTER)
  const line = useStore(savingsLine)
  return { available: shown && line.lines.length > 0, ...line }
}

const NO_HOLDINGS = memoryStore<QueryState<never>>({ status: "pending" }).readonly

/**
 * The holding a deposit swept on each L1 token lands in, once the deployment is read; pending for
 * a visitor.
 */
export function useSavingsTokens(): ReadonlyMap<string, string> | undefined {
  const { moveCommands, page } = useSession()
  const holdings = useStore(moveCommands ? page.chain.holdings : NO_HOLDINGS)
  const listed = page.config.holdings
  return useMemo(() => selectSavingsTokens(holdings, listed), [holdings, listed])
}

/** Whether the nav offers Savings: the wallet lists a holding, or the account has a line. */
export function useSavingsAvailable(): boolean {
  const { page, savingsLine } = useSession()
  const listed = useStore(page.chain.holdings, (s) => selectSavingsListed(s, page.config.holdings))
  const held = useStore(savingsLine, (s) => s.lines.length > 0)
  return listed || held
}

/** Each holding's price by id; a visitor has none. */
export function useHoldingPrices(): ReadonlyMap<string, HoldingPrice> {
  const { moveCommands, page } = useSession()
  const holdings = useStore(moveCommands ? page.chain.holdings : NO_HOLDINGS)
  const prices = useStore(moveCommands ? page.chain.savingsPrices : NO_HOLDINGS)
  return useMemo(() => selectHoldingPrices(holdings, prices), [holdings, prices])
}
