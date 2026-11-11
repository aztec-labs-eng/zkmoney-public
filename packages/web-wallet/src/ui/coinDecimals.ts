const FINE: ReadonlySet<string> = new Set(["ETH", "WETH", "BTC", "WBTC", "CBBTC", "TBTC"])

/** The decimals a coin's amounts show: 5 for ETH and BTC coins, 2 for stablecoins. */
export function displayDecimals(symbol: string): number {
  return FINE.has(symbol.toUpperCase()) ? 5 : 2
}

/**
 * `23.94 USDC` / `0.01234 ETH`: an amount rounded half up to its coin's display decimals, grouped.
 * Stablecoins keep both cents unless whole; fine coins drop trailing zeros. Dust never reads as zero.
 */
export function coinFigure(atomic: bigint, decimals: number, symbol: string): string {
  const places = Math.min(displayDecimals(symbol), decimals)
  const step = 10n ** BigInt(decimals - places)
  const sign = atomic < 0n ? "-" : ""
  const abs = atomic < 0n ? -atomic : atomic
  const units = (abs + step / 2n) / step
  if (abs > 0n && units === 0n) return `<0.${"1".padStart(places, "0")} ${symbol}`
  const scale = 10n ** BigInt(places)
  const whole = (units / scale).toLocaleString("en-US")
  const fraction = String(units % scale).padStart(places, "0")
  const shown = displayDecimals(symbol) === 2 ? fraction.replace(/^00$/, "") : fraction.replace(/0+$/, "")
  return `${sign}${whole}${shown ? `.${shown}` : ""} ${symbol}`
}
