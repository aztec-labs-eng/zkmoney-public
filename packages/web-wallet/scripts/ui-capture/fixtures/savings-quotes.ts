import * as actual from "@obsidion/front-core"
import {
  savingsFixture,
  savingsQuote,
  savingsVaultSwapQuote,
  savingsVaultSwapTargets,
} from "./savings-seed"
export * from "@obsidion/front-core"

type Key = [holdingId: string, direction: actual.MoveDirection, amount: bigint]

/** A move's quote from the savings fixture: the demo builds no account to price one on L1. */
export const moveQuotes: typeof actual.moveQuotes = (query, ports) =>
  savingsFixture()
    ? query<Key, actual.MoveQuote>("moveQuote", {
        load: async (holdingId, direction, amount) => savingsQuote(holdingId, direction, amount),
        stale: actual.MOVE_QUOTE_STALE_MS,
      })
    : actual.moveQuotes(query, ports)

/** A swap's quote from the savings fixture, for the same reason. */
export const vaultSwapQuotes: typeof actual.vaultSwapQuotes = (query, ports) =>
  savingsFixture()
    ? query<[fromId: string, toId: string, amount: bigint], actual.MoveQuote>("vaultSwapQuote", {
        load: async (fromId, toId, amount) => savingsVaultSwapQuote(fromId, toId, amount),
        stale: actual.MOVE_QUOTE_STALE_MS,
      })
    : actual.vaultSwapQuotes(query, ports)

/** What the engine offers each fixture line to swap into, over the fixture's own rails. */
export const vaultSwapTargets: typeof actual.vaultSwapTargets = (rails) => {
  const fixture = savingsFixture()
  return fixture ? savingsVaultSwapTargets(fixture) : actual.vaultSwapTargets(rails)
}
