import { useEffect } from "react"
import { useAssetContext, type Asset } from "@obsidion/front-core"
import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import { demoScenario } from "./demoFlag"
import { DEMO_L2_TOKEN } from "./demoFixtures"

const emptyAsset: Asset = {
  address: DEMO_L2_TOKEN,
  name: WALLET_TOKEN_SYMBOL,
  symbol: WALLET_TOKEN_SYMBOL,
  decimals: 18,
  balance: 0,
  balanceAtomic: 0n,
  publicBalance: 0,
  privateBalance: 0,
  price: 1,
  change: 0,
  changeAmount: 0,
  logo: "",
}

/** Zero cached assets are omitted by normal hydration; the offline fixture has no live fetch. */
export default function DemoEmptyBalance() {
  const { assets, setAssets } = useAssetContext()
  useEffect(() => {
    if (demoScenario() === "empty" && !assets?.length) setAssets([emptyAsset])
  }, [assets, setAssets])
  return null
}
