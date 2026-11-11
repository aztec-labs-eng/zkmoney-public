/** What the claim's bridge route pays and lands, from the route's last quote. */
import { DEFAULT_DECIMALS, WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import type { QueryState } from "@obsidion/front-core"
import type { BridgeOutToken } from "@obsidion/sdk"
import type { ConfigBridgeChain } from "@obsidion/config-client"
import {
  bridgeOutDecimals,
  type BridgeOutAnswer,
  type BridgeOutChain,
  type BridgeOutPriced,
} from "../withdraw/bridgeOutQuote"
import { claimBridgeKey, type ClaimRouteState } from "./claimRouteTransition"

export interface ClaimBridge {
  route: BridgeOutChain
  token: BridgeOutToken
  /** The decimals of what lands. */
  decimals: number
  /** The last quote for this chain, token and amount, whatever tip it was priced on. */
  quote?: BridgeOutPriced
  /** No quote: the read failed, or the amount is under the bridge's floor. */
  failed: boolean
  /** The amount less what lands, in DAI units. */
  feeAtomic?: bigint
}

/** The bridge route chosen in `state`; undefined on Ethereum or before its chain is offered. */
export function selectClaimBridge(
  state: ClaimRouteState,
  routes: readonly BridgeOutChain[],
  amount: bigint | undefined,
  read: QueryState<BridgeOutAnswer> | undefined,
): ClaimBridge | undefined {
  const { route: chosen } = state
  if (chosen.kind !== "bridge") return undefined
  const route = routes.find((r) => r.chain.chainId === chosen.chainId)
  if (!route) return undefined
  const { token } = chosen
  const decimals = bridgeOutDecimals(token, chosen.chainId)
  const priced =
    amount !== undefined && state.priced?.key === claimBridgeKey(chosen.chainId, token, amount)
      ? state.priced.quote
      : undefined
  const failed = read?.status === "failed" || (read?.status === "ready" && !!read.value.below)
  if (!priced || amount === undefined) return { route, token, decimals, failed }
  const landed = priced.minReceived * 10n ** BigInt(DEFAULT_DECIMALS - decimals)
  return {
    route,
    token,
    decimals,
    quote: priced,
    failed,
    feeAtomic: amount > landed ? amount - landed : 0n,
  }
}

/** Whether the amount covers the withdrawal with `tip` on top; undefined until priced. */
export const claimBridgeCovers = (
  bridge: ClaimBridge,
  amount: bigint | undefined,
  tip: bigint,
): boolean | undefined =>
  bridge.quote && amount !== undefined
    ? amount > bridge.quote.withdrawalFee + WITHDRAW_RELAYER_TIP + tip
    : undefined

/** The bridge leg the claim burns with `proverTip`; undefined until a quote at that tip. */
export function claimBridgeChoice(
  bridge: ClaimBridge,
  proverTip: bigint,
):
  | { chain: ConfigBridgeChain; token: BridgeOutToken; quote: BridgeOutPriced; proverTip: bigint }
  | undefined {
  const { quote } = bridge
  if (quote?.proverTip !== proverTip) return undefined
  return { chain: bridge.route.chain, token: bridge.token, quote, proverTip }
}
