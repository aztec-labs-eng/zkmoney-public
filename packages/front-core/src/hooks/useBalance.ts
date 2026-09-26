import { useMemo } from "react"
import { useAssetContext } from "src/contexts"
import { selectWalletAsset } from "../utils/tokenIdentity"
import { useSyncCatchingUp } from "./useSyncCatchingUp"

/**
 * Derives balance from asset context.
 * Returns formatted USD balance and the raw wallet-token balance.
 */
export function useBalance() {
  const { assets, liveAssetsLoaded, activeTokenAddress } = useAssetContext()
  const catchingUp = useSyncCatchingUp()

  return useMemo(() => {
    const walletAsset = selectWalletAsset(assets, activeTokenAddress)
    const balanceUsd = walletAsset ? walletAsset.balance * walletAsset.price : 0
    const walletBalance = walletAsset ? walletAsset.balance : 0

    return {
      totalBalanceUsd: balanceUsd.toFixed(2),
      walletBalance: walletBalance.toFixed(2),
      walletAsset,
      // True once an on-chain fetch has completed this session (a failed load
      // keeps the previous value). Cache-hydrated cold-start balances do NOT
      // set it — they are display-only, so overspend gating never trusts a
      // stale value. `walletAsset` alone can't signal this: zero-balance assets
      // are filtered out, so it stays null forever for an empty account.
      assetsLoaded: liveAssetsLoaded,
      // The display gate: holding a placeholder past this point hides the
      // hydrated balance the cache exists to show. A resolved asset is enough,
      // and so is a completed live fetch that legitimately found none — but an
      // ambiguous cache the selector declined to guess at is NOT, or the
      // placeholder gives way to a confident $0 that may not be the truth. A fresh device's first
      // chain pass rewrites the balance chunk by chunk as its deposits replay, so the placeholder
      // also holds until that pass ends rather than show each intermediate figure.
      balanceKnown: !catchingUp && (liveAssetsLoaded || walletAsset !== null),
    }
  }, [assets, liveAssetsLoaded, activeTokenAddress, catchingUp])
}
