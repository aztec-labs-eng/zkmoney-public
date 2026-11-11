/** Where a paylink claimed to an external wallet lands: Ethereum, or another chain over Across. */
import type { BridgeOutToken } from "@obsidion/sdk"
import type { BridgeOutPriced } from "../withdraw/bridgeOutQuote"
import type { WithdrawalReceiveAsset } from "../withdraw/withdrawAssets"

export type ClaimRoute =
  | { kind: "ethereum"; asset: WithdrawalReceiveAsset }
  | { kind: "bridge"; chainId: number; token: BridgeOutToken }

export interface ClaimRouteState {
  route: ClaimRoute
  /** The last quote for the bridge at `key`, kept while a new tip prices it again. */
  priced?: { key: string; quote: BridgeOutPriced }
}

export type ClaimRouteEvent =
  | { type: "route"; route: ClaimRoute }
  | { type: "priced"; key: string; quote: BridgeOutPriced }

export const CLAIM_ROUTE_START: ClaimRouteState = { route: { kind: "ethereum", asset: "DAI" } }

/** What a bridge quote prices apart from the tip. */
export const claimBridgeKey = (chainId: number, token: BridgeOutToken, amount: bigint): string =>
  `${chainId}:${token}:${amount}`

export function claimRouteTransition(s: ClaimRouteState, e: ClaimRouteEvent): ClaimRouteState {
  switch (e.type) {
    case "route":
      return { route: e.route }
    case "priced":
      return { ...s, priced: { key: e.key, quote: e.quote } }
  }
}
