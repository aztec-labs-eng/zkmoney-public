import type { OxideEnvTuple } from "@obsidion/core/types"
import type { Query, QueryFactory, QueryState } from "@obsidion/front-core"
import type { SwapArgs, SwapQuote, WithdrawalQuoteState } from "./withdrawQuote"

/** How often a priced route is re-simulated: the relayer's own re-quote cadence. */
export const SWAP_QUOTE_REFRESH_MS = 30_000

/** A quote older than two refreshes prices a market, or a burn's landing, that has moved on. */
export const SWAP_QUOTE_MAX_AGE_MS = 2 * SWAP_QUOTE_REFRESH_MS

/** The source that prices a route on the active deployment. */
export const ACTIVE_SOURCE = "active"

/**
 * Every input a swap quote depends on. `source` names the deployment it is priced on:
 * {@link ACTIVE_SOURCE}, a paylink's token, or null while that token is unread.
 */
export type RouteKey = SwapArgs & { source: string | null }

/** A route's inputs on a known deployment. */
export type SwapKey = RouteKey & { source: string }

export type SwapQuotes = Query<[SwapKey], SwapQuote>

/** Whether the key names its deployment, so it can be priced. */
export const priced = (key: RouteKey): key is SwapKey => key.source !== null

export interface SwapQuoteDeps {
  /** The active deployment's tuple. */
  active: (signal: AbortSignal) => Promise<OxideEnvTuple>
  /** The tuple of the deployment a paylink's token belongs to. */
  token: (token: string) => Promise<OxideEnvTuple>
  /** One simulation of the swap on `tuple`'s deployment. */
  simulate: (args: SwapArgs, tuple: OxideEnvTuple) => Promise<SwapQuote>
}

/**
 * The page's swap simulations, re-run every {@link SWAP_QUOTE_REFRESH_MS} while a view shows them,
 * each on its source's deployment.
 */
export const swapQuotes = (query: QueryFactory, deps: SwapQuoteDeps): SwapQuotes =>
  query<[SwapKey], SwapQuote>("swapQuote", {
    load: async ({ source, ...args }, signal) =>
      deps.simulate(
        args,
        source === ACTIVE_SOURCE ? await deps.active(signal) : await deps.token(source),
      ),
    poll: SWAP_QUOTE_REFRESH_MS,
    stale: SWAP_QUOTE_MAX_AGE_MS,
  })

/** Whether the key's route runs a swap: anything but DAI with no gas share. */
export const swapsTo = (key: SwapArgs) => key.output !== "DAI" || (key.daiForGas ?? 0n) > 0n

/** The same deployment and route: DAI with a gas swap is an escrow, priced apart from direct DAI. */
export const sameRoute = (a: RouteKey, b: RouteKey) =>
  a.source === b.source &&
  a.output === b.output &&
  (a.daiForGas ?? 0n) > 0n === (b.daiForGas ?? 0n) > 0n

/** The fee a route's last simulation priced, kept while it runs again or after it failed. */
export const feeOf = (state: QueryState<SwapQuote>) =>
  state.status === "ready" ? state.value.fee : undefined

type Read = { key: RouteKey; state: QueryState<SwapQuote> }

/**
 * A swap route as a view shows it: the debounced key's quote once it is the typed one, held while
 * it is simulated again, or unavailable once its simulation failed. Until then it is loading, with
 * the fee of a quote the debounced key or the one before it got on the same deployment and route,
 * so the floor never flickers away. A route debounced in between carries nothing, and a quote from
 * other inputs never shows as ready.
 */
export function shownQuote(typed: RouteKey, held: Read, before?: Read): WithdrawalQuoteState {
  const { key, state } = held
  if (key === typed && state.status === "failed") return { status: "unavailable" }
  if (key === typed && state.status === "ready")
    return state.error === undefined
      ? { status: "ready", ...state.value }
      : { status: "unavailable" }
  if (!sameRoute(key, typed)) return { status: "loading" }
  const carried = before && sameRoute(before.key, typed) ? feeOf(before.state) : undefined
  return { status: "loading", fee: feeOf(state) ?? carried }
}
