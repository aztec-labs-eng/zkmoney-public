import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import type { Asset } from "../types/tokens"

/** True for the wallet's token symbol, case-insensitively. */
export function isWalletTokenSymbol(symbol: string | undefined | null): boolean {
  return !!symbol && symbol.toUpperCase() === WALLET_TOKEN_SYMBOL.toUpperCase()
}

/**
 * The asset the wallet should spend and display, or null when it cannot be identified.
 *
 * Keyed on the active token address rather than the symbol. `TokenStorage` keeps a row per token
 * address and never drops old ones, so after a token redeploy two rows carry the same symbol —
 * at which point a symbol match stops discriminating and list ordering silently decides which
 * balance and which decimals win.
 *
 * Balances hydrate from cache before the wallet knows that address, so with none supplied this
 * resolves a lone candidate and otherwise returns null. Guessing there can pin a stale balance on
 * screen for as long as initialization keeps failing.
 */
export function selectWalletAsset(
  assets: Asset[] | null | undefined,
  activeAddress: string | null | undefined,
): Asset | null {
  if (!assets?.length) return null

  const candidates = assets.filter((a) => isWalletTokenSymbol(a.symbol))
  if (candidates.length === 0) return null

  if (activeAddress) {
    const target = activeAddress.toLowerCase()
    return candidates.find((a) => a.address.toLowerCase() === target) ?? null
  }

  return candidates.length === 1 ? candidates[0]! : null
}
