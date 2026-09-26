import { createContext, useContext, ReactNode } from "react"
import { useStorage } from "../hooks"
import { assert } from "ts-essentials"
import type { IStorageAdapter, NetworkStorageConfig } from "src/core"

type StorageContextProps = ReturnType<typeof useStorage>

const StorageContext = createContext<StorageContextProps | undefined>(undefined)

export const StorageProvider = ({
  children,
  networkConfig,
  storageAdapter,
}: {
  children: ReactNode
  networkConfig: NetworkStorageConfig
  storageAdapter: IStorageAdapter
}) => {
  const storage = useStorage(networkConfig, storageAdapter)

  return <StorageContext.Provider value={storage}>{children}</StorageContext.Provider>
}

export const useStorageContext = (): StorageContextProps => {
  const context = useContext(StorageContext)
  assert(context, "useStorageContext must be used within a StorageProvider")
  return context
}
