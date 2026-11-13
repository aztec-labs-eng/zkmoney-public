import { UNREAD, useStore } from "@obsidion/front-core"
import { ETH_USD_FEED_DECIMALS } from "@obsidion/sdk"
import { formatUnits, type Address } from "viem"
import { coinFigure } from "../../../ui/coinDecimals"
import { useSession } from "../../../session/session"
import { usdFigureGrouped } from "../../limits/publicLimit"
import { coinBalanceFigure, coinUsdRate, readValue, type CoinPricing } from "../coinBalance"
import styles from "./CoinBalance.module.css"

/**
 * `account`'s balance of one coin for its picker row: the amount, with its dollar value under it
 * where the coin is priced. Nothing while unread, failed or zero.
 */
export function CoinBalance({
  account,
  chainId,
  l1,
  token,
  symbol,
  pricing,
}: {
  account: Address
  chainId: number
  /** Read on the L1; else on the origin chain `chainId`. */
  l1: boolean
  /** The chain's gas coin is the zero address; none on the L1 is the deployment's token. */
  token: Address | undefined
  symbol: string
  pricing: CoinPricing
}) {
  const { page } = useSession()
  const l1Read = useStore(l1 ? page.l1Balance(account, token) : UNREAD, readValue)
  const origin = l1 ? undefined : token
  const originAtomic = useStore(
    origin ? page.originBalance(chainId, origin, account) : UNREAD,
    readValue,
  )
  const originToken = useStore(origin ? page.originToken(chainId, origin) : UNREAD, readValue)
  const ethUsd = useStore(pricing === "eth" ? page.ethUsd : UNREAD, readValue)
  const rate = coinUsdRate(
    pricing,
    ethUsd === undefined ? undefined : { answer: ethUsd, feedDecimals: ETH_USD_FEED_DECIMALS },
  )
  const figure = coinBalanceFigure(
    l1 ? l1Read?.raw : originAtomic,
    l1 ? l1Read?.decimals : originToken?.decimals,
    rate,
  )
  if (!figure) return null
  return (
    <span className={styles.balance} data-testid={`coin-balance-${symbol}`}>
      <b>{coinFigure(figure.atomic, figure.decimals, symbol)}</b>
      {/* The dollar line keeps its height until the price arrives, so the amount never moves. */}
      <small aria-hidden={figure.usd === undefined || undefined}>
        {figure.usd !== undefined && usdFigureGrouped(formatUnits(figure.usd, 18))}
      </small>
    </span>
  )
}
