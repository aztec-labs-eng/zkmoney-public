import { ReactNode } from "react"
import {
  AztecProvider,
  ContractServiceProvider,
  AccountProvider,
  AssetProvider,
  useContractServiceContext,
  OidcKeyRegistryProvider,
} from "./"
import type { IContractServiceStorage, ContractServiceOptions } from "@obsidion/sdk"
import type { IStorageAdapter, NetworkStorageConfig } from "src/core"
import type { UseAuthenticator, UseAssetOptions } from "src/hooks"
import { StorageProvider, useStorageContext } from "./useStorageContext"

/**
 * ObsidionCoreProvider wraps the core infrastructure providers needed for the Obsidion application:
 * - AztecProvider: Manages PXE, Aztec node, and network connections
 * - ContractServiceProvider: Manages contract services and interactions
 */
export const ObsidionCoreProvider = ({
  children,
  networkConfig,
  storageAdapter,
  contractServiceStorage,
  contractServiceOptions,
  isTestAccount,
}: {
  children: ReactNode
  networkConfig: NetworkStorageConfig
  storageAdapter: IStorageAdapter
  contractServiceStorage: IContractServiceStorage
  contractServiceOptions: ContractServiceOptions
  isTestAccount?: boolean
}) => {
  return (
    <StorageProvider networkConfig={networkConfig} storageAdapter={storageAdapter}>
      <ObsidionCoreProviderInner
        contractServiceStorage={contractServiceStorage}
        contractServiceOptions={contractServiceOptions}
        isTestAccount={isTestAccount}
      >
        {children}
      </ObsidionCoreProviderInner>
    </StorageProvider>
  )
}

const ObsidionCoreProviderInner = ({
  children,
  contractServiceStorage,
  contractServiceOptions,
  isTestAccount,
}: {
  children: ReactNode
  contractServiceStorage: IContractServiceStorage
  contractServiceOptions: ContractServiceOptions
  isTestAccount?: boolean
}) => {
  const { storageAdapter } = useStorageContext()
  if (!storageAdapter) return null
  return (
    <AztecProvider isTestAccount={isTestAccount}>
      <ContractServiceProvider storage={contractServiceStorage} options={contractServiceOptions}>
        {children}
      </ContractServiceProvider>
    </AztecProvider>
  )
}

/**
 * ObsidionAppProvider wraps all the application-level providers:
 * - AccountProvider: Manages user accounts and wallet state
 * - AssetProvider: Manages token assets and balances
 * - OidcKeyRegistryProvider: Exposes the on-chain OidcKeyRegistry surface that
 *   paylink-by-email claim depends on (issuer-scoped JWK / aud validation).
 */
export const ObsidionAppProvider = ({
  children,
  useAuthenticator,
  assetOptions,
}: {
  children: ReactNode
  useAuthenticator: UseAuthenticator
  assetOptions?: UseAssetOptions
}) => {
  const { contractService } = useContractServiceContext()
  if (!contractService) return null

  return (
    <AccountProvider useAuthenticator={useAuthenticator}>
      <AssetProvider assetOptions={assetOptions}>
        <OidcKeyRegistryProvider>{children}</OidcKeyRegistryProvider>
      </AssetProvider>
    </AccountProvider>
  )
}
