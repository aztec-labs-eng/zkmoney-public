import { useEffect, useState } from "react"
import {
  AccountStorage,
  BalanceStorage,
  ContactStorage,
  NetworkStorage,
  TokenStorage,
  TransactionStorage,
  WithdrawalStorage,
  type IStorageAdapter,
  type NetworkStorageConfig,
} from "src/core"
import { logger } from "src/utils/logger"

export const useStorage = (
  networkConfig: NetworkStorageConfig,
  _storageAdapter: IStorageAdapter,
) => {
  const [storageAdapter, setStorageAdapter] = useState<IStorageAdapter | null>(null)
  useEffect(() => {
    const initStorage = async () => {
      logger.log("initStorage...")
      logger.log("activeNetwork", networkConfig.activeNetwork)
      if (storageAdapter || !networkConfig.activeNetwork) return

      NetworkStorage.get(_storageAdapter, networkConfig)
      AccountStorage.get(_storageAdapter)
      BalanceStorage.get(_storageAdapter)
      TokenStorage.get(_storageAdapter)
      ContactStorage.get(_storageAdapter)
      TransactionStorage.get(_storageAdapter)
      WithdrawalStorage.get(_storageAdapter)
      setStorageAdapter(_storageAdapter)
    }
    initStorage()
  }, [storageAdapter])

  return { storageAdapter }
}
