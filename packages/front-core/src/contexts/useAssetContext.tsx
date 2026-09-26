import { createContext, useContext, ReactNode } from "react"
import { useAsset, UseAssetOptions } from "../hooks/useAsset"
import { assert } from "ts-essentials"

type AssetContextProps = ReturnType<typeof useAsset>

const AssetContext = createContext<AssetContextProps | undefined>(undefined)

export const AssetProvider = ({
  children,
  assetOptions,
}: {
  children: ReactNode
  assetOptions?: UseAssetOptions
}) => {
  const asset = useAsset(assetOptions)

  return <AssetContext.Provider value={asset}>{children}</AssetContext.Provider>
}

export const useAssetContext = (): AssetContextProps => {
  const context = useContext(AssetContext)
  assert(context, "useAssetContext must be used within an AssetProvider")
  return context
}
