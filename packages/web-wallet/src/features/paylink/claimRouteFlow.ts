/** The claim-to-wallet modal's route choice and the bridge quote it keeps while re-pricing. */
import {
  liveStore,
  memoryStore,
  type QueryEntry,
  type QueryState,
  type ReadonlyStore,
} from "@obsidion/front-core"
import type { ScreenFlow } from "../../ui/useScreenFlow"
import {
  bridgeOutSendable,
  type BridgeOutAnswer,
  type BridgeOutAsk,
  type BridgeOutPriced,
} from "../withdraw/bridgeOutQuote"
import {
  CLAIM_ROUTE_START,
  claimBridgeKey,
  claimRouteTransition,
  type ClaimRoute,
  type ClaimRouteEvent,
  type ClaimRouteState,
} from "./claimRouteTransition"

export interface ClaimRouteFlow extends ScreenFlow {
  state: ReadonlyStore<ClaimRouteState>
  choose(route: ClaimRoute): void
  /** The quote for `ask`; while subscribed, each priced answer becomes the flow's `priced`. */
  quote(ask: BridgeOutAsk): ReadonlyStore<QueryState<BridgeOutAnswer>>
  /**
   * The quote a confirm burns: `ask` priced again now, kept as `priced`. Undefined when it lands
   * worse than `reviewed`, so the review shows it instead.
   */
  sendable(
    ask: BridgeOutAsk,
    reviewed: BridgeOutPriced,
    signal?: AbortSignal,
  ): Promise<BridgeOutPriced | undefined>
}

export function openClaimRouteFlow(deps: {
  quotes: (ask: BridgeOutAsk) => QueryEntry<BridgeOutAnswer>
}): ClaimRouteFlow {
  const state = memoryStore<ClaimRouteState>(CLAIM_ROUTE_START)
  const dispatch = (event: ClaimRouteEvent) => state.set(claimRouteTransition(state.get(), event))
  let watched: { ask: BridgeOutAsk; store: ReadonlyStore<QueryState<BridgeOutAnswer>> } | undefined
  return {
    start() {},
    state: state.readonly,
    choose: (route) => dispatch({ type: "route", route }),
    quote(ask) {
      if (watched?.ask === ask) return watched.store
      const entry = deps.quotes(ask)
      const key = claimBridgeKey(ask.chainId, ask.token, ask.amount)
      const store = liveStore(entry.get(), {
        whileSubscribed(set) {
          const follow = () => {
            const read = entry.get()
            set(read)
            if (read.status === "ready" && read.value.quote)
              dispatch({ type: "priced", key, quote: read.value.quote })
          }
          const off = entry.subscribe(follow)
          follow()
          return off
        },
      })
      watched = { ask, store }
      return store
    },
    async sendable(ask, reviewed, signal) {
      const entry = deps.quotes(ask)
      entry.refresh()
      const fresh = await entry.read(signal)
      if (fresh.quote)
        dispatch({
          type: "priced",
          key: claimBridgeKey(ask.chainId, ask.token, ask.amount),
          quote: fresh.quote,
        })
      return bridgeOutSendable(reviewed, fresh)
    },
  }
}
