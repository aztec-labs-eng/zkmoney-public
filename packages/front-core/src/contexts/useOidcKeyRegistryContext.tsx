import { createContext, ReactNode, useContext, useEffect, useState } from "react"
import { assert } from "ts-essentials"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { ContractService, DEFAULT_CONTRACTS, OidcKeyRegistryService } from "@obsidion/sdk"
import { useAccountContext } from "./useAccountContext"
import { useAztecContext } from "./useAztecContext"
import { logger } from "src/utils/logger"

interface OidcKeyRegistryContextProps {
  oidcKeyRegistryService: OidcKeyRegistryService | null
  oidcKeyRegistryAddress: AztecAddress | null
}

const OidcKeyRegistryContext = createContext<OidcKeyRegistryContextProps | undefined>(undefined)

/**
 * Thin provider exposing the on-chain `OidcKeyRegistry` surface that
 * paylink-by-email claim depends on (issuer-scoped JWK / aud validation).
 */
export const OidcKeyRegistryProvider = ({ children }: { children: ReactNode }) => {
  const { obsidionWallet } = useAztecContext()
  const { obsidionAccount } = useAccountContext()
  const [oidcKeyRegistryService, setOidcKeyRegistryService] =
    useState<OidcKeyRegistryService | null>(null)
  const [oidcKeyRegistryAddress, setOidcKeyRegistryAddress] = useState<AztecAddress | null>(null)

  useEffect(() => {
    const init = async () => {
      if (!obsidionWallet || !obsidionAccount) return

      try {
        const contractAddress = await ContractService.getInstance().getContractAddress(
          DEFAULT_CONTRACTS.oidcKeyRegistry,
        )

        const service = new OidcKeyRegistryService(obsidionWallet, contractAddress || undefined)
        setOidcKeyRegistryService(service)
      } catch (err) {
        logger.log("Error initializing PaylinkRegistry email service", err)
      }
    }
    init()
  }, [obsidionWallet, obsidionAccount])

  useEffect(() => {
    const fetchAddress = async () => {
      if (!oidcKeyRegistryService) return
      const address = await oidcKeyRegistryService.getContractAddress()
      if (!address) {
        console.warn(
          "[OidcKeyRegistry] contract address not resolved — email paylinks will stay unavailable",
        )
        return
      }
      setOidcKeyRegistryAddress(address)
    }
    fetchAddress()
  }, [oidcKeyRegistryService])

  const value: OidcKeyRegistryContextProps = {
    oidcKeyRegistryService,
    oidcKeyRegistryAddress,
  }

  return <OidcKeyRegistryContext.Provider value={value}>{children}</OidcKeyRegistryContext.Provider>
}

export const useOidcKeyRegistryContext = (): OidcKeyRegistryContextProps => {
  const context = useContext(OidcKeyRegistryContext)
  assert(context, "useOidcKeyRegistryContext must be used within a OidcKeyRegistryProvider")
  return context
}
