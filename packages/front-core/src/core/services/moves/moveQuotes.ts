import type { MoveDirection, MoveQuote } from "../../../engine/moveTransition"
import type { QueryEntry, QueryFactory } from "../../../engine/query"
import type { Service } from "../../../engine/service"
import { withHolding } from "./openMoves"
import type { MovePorts } from "./types"

/** How long a move's quote holds: the relayer's tips follow L1 gas. */
export const MOVE_QUOTE_STALE_MS = 30_000

export type MoveQuotes = (
  holdingId: string,
  direction: MoveDirection,
  amount: bigint,
) => QueryEntry<MoveQuote>

/** What a move of `amount` into or out of a holding costs and lands, priced on L1 by its rail. */
export function moveQuotes(query: QueryFactory, ports: Service<MovePorts>): MoveQuotes {
  return query<[holdingId: string, direction: MoveDirection, amount: bigint], MoveQuote>(
    "moveQuote",
    {
      load: async (holdingId, direction, amount, signal) =>
        withHolding(await ports.ready(signal), holdingId, async (routes, holding) =>
          routes.quote(await routes.read(holding), direction, amount),
        ),
      stale: MOVE_QUOTE_STALE_MS,
    },
  )
}
