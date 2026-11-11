import type { BridgeOutProviderId } from "@obsidion/sdk"
import type { Address, Hex } from "viem"
import type { BridgeInStatus } from "../crossChain/types"

/** What the tracker reads of a bridge-out's deposit, once its escrow ran. */
export interface BridgeOutTracking {
  id: BridgeOutProviderId
  /** The bridge's report on the deposit the escrow's run made, by that run's L1 tx. */
  status(executeTxHash: Hex): Promise<BridgeInStatus | undefined>
  /** What a fill on `chainId` paid `recipient`, in output-token units; undefined when unread. */
  fill(chainId: number, fillTxHash: Hex, recipient: Address): Promise<bigint | undefined>
}

/**
 * A bridge that carries a withdrawal to another chain: the routes it serves, its quote, and its
 * report on each deposit. A front supplies its own route, ask and quote shapes.
 */
export interface BridgeOutProvider<Route, Ask, Quote> extends BridgeOutTracking {
  /** The routes from the deployment that holds L2 `token`. */
  routes(token: string): Promise<Route[]>
  quote(ask: Ask): Promise<Quote>
}
