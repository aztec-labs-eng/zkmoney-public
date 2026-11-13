import type { QueryState } from "@obsidion/front-core"
import { getAddress, type Address } from "viem"

/** USD per whole token, as a fraction. */
export interface UsdRate {
  numerator: bigint
  denominator: bigint
}

/** How a picker row prices its coin: a nominal $1, the ETH feed, or not at all. */
export type CoinPricing = "nominal" | "eth" | undefined

/** A wallet's balance of one coin, as a picker row shows it. */
export interface CoinBalanceFigure {
  atomic: bigint
  decimals: number
  /** Its value in dollars, 18 decimals; absent where the coin has no price. */
  usd?: bigint
}

/**
 * Whose balances the picker shows: the saved wallet a flow started from, which it sends from, even
 * before it connects; else the connected account.
 */
export const balanceAccount = (
  saved: { address: string } | undefined,
  connected: Address | null | undefined,
): Address | undefined => (saved ? getAddress(saved.address) : connected ?? undefined)

/** A read's value; nothing while unread or failed. */
export const readValue = <T>(s: QueryState<T>): T | undefined =>
  s.status === "ready" ? s.value : undefined

/** The coins the ETH feed prices: ETH and its wrapped form, on any chain. */
const ETH_PRICED: ReadonlySet<string> = new Set(["ETH", "WETH"])

/**
 * A row's pricing. The L1 deposit coins are valued at a nominal $1, as the bridge sheet reads them;
 * ETH and WETH take the ETH feed's price; anything else, such as another chain's gas coin, has none.
 */
export const coinPricing = (coins: readonly { symbol: string }[], symbol: string): CoinPricing =>
  coins.some((c) => c.symbol === symbol) ? "nominal" : ETH_PRICED.has(symbol) ? "eth" : undefined

/** The rate `pricing` names, given the ETH feed's answer at `feedDecimals` where it is read. */
export function coinUsdRate(
  pricing: CoinPricing,
  eth: { answer: bigint; feedDecimals: bigint } | undefined,
): UsdRate | undefined {
  if (pricing === "nominal") return { numerator: 1n, denominator: 1n }
  if (pricing === "eth" && eth)
    return { numerator: eth.answer, denominator: 10n ** eth.feedDecimals }
  return undefined
}

/** The row's balance: none while it or its decimals are unread, or when it is zero. */
export function coinBalanceFigure(
  atomic: bigint | undefined,
  decimals: number | undefined,
  rate: UsdRate | undefined,
): CoinBalanceFigure | undefined {
  if (atomic === undefined || decimals === undefined || atomic === 0n) return undefined
  if (!rate) return { atomic, decimals }
  const usd = (atomic * rate.numerator * 10n ** 18n) / (rate.denominator * 10n ** BigInt(decimals))
  return { atomic, decimals, usd }
}
