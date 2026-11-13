import { useStore } from "@obsidion/front-core"
import type { Address } from "viem"
import { useSession } from "../../../session/session"
import { CoinBalance } from "../../deposit/CoinBalance/CoinBalance"
import { readValue } from "../../deposit/coinBalance"
import type { BridgeOutChain } from "../bridgeOutQuote"
import { withdrawCoinRead } from "../withdrawCoinBalance"

/** The recipient's balance of what a withdraw picker row lands. */
export function RecipientCoinBalance({
  recipient,
  chainId,
  symbol,
  l1ChainId,
  routes,
}: {
  recipient: Address
  chainId: number
  symbol: string
  l1ChainId: number
  routes: readonly BridgeOutChain[]
}) {
  const { page } = useSession()
  // The deposit table names the L1 tokens and the dollar coins every row is priced by.
  const l1Tokens = useStore(page.depositTokens("deposit"), readValue)?.options
  const read = withdrawCoinRead(symbol, chainId, { l1ChainId, routes, l1Tokens })
  if (!read) return null
  return (
    <CoinBalance
      account={recipient}
      chainId={chainId}
      l1={read.l1}
      token={read.token}
      symbol={symbol}
      pricing={read.pricing}
    />
  )
}
