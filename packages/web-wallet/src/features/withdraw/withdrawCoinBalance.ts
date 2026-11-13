import { zeroAddress, type Address } from "viem"
import { coinPricing, type CoinPricing } from "../deposit/coinBalance"
import type { BridgeOutChain } from "./bridgeOutQuote"

/** Where a picker row reads the recipient's balance of the coin that lands. */
export interface WithdrawCoinRead {
  /** On the L1; else on the bridge chain. */
  l1: boolean
  /** None on the L1 is the deployment's token; the zero address is the chain's gas coin. */
  token: Address | undefined
  pricing: CoinPricing
}

/**
 * The read for `symbol` landing on `chainId`. On the L1, DAI is the deployment's token, ETH the gas
 * coin, and any other coin the L1 token of that symbol the deposit table lists; on a bridge chain,
 * the route's token. None where the token is unknown. Priced as the deposit picker prices it.
 */
export function withdrawCoinRead(
  symbol: string,
  chainId: number,
  ctx: {
    l1ChainId: number
    routes: readonly Pick<BridgeOutChain, "chain" | "tokens">[]
    /** The deposit table's L1 tokens, which also set the dollar coins; undefined until read. */
    l1Tokens: readonly { symbol: string; address: Address }[] | undefined
  },
): WithdrawCoinRead | undefined {
  const pricing = coinPricing(ctx.l1Tokens ?? [], symbol)
  if (chainId !== ctx.l1ChainId) {
    const route = ctx.routes.find((r) => r.chain.chainId === chainId)
    const token = route?.tokens.find((t) => t.symbol === symbol)?.address
    return token ? { l1: false, token, pricing } : undefined
  }
  if (symbol === "DAI") return { l1: true, token: undefined, pricing }
  if (symbol === "ETH") return { l1: true, token: zeroAddress, pricing }
  const token = ctx.l1Tokens?.find((t) => t.symbol === symbol)?.address
  return token ? { l1: true, token, pricing } : undefined
}
