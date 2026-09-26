import { createContext, useContext, ReactNode, useState, useEffect, useRef } from "react"
import { assert } from "ts-essentials"
import {
  ContractService,
  ContractServiceOptions,
  DEFAULT_CONTRACTS,
  IContractServiceStorage,
  Network,
} from "@obsidion/sdk"
import { NetworkStorage } from "src/core"
import { useAztecContext } from "./useAztecContext"
import { logger } from "src/utils/logger"

interface ContractServiceContextProps {
  contractService: ContractService | null
}

const ContractServiceContext = createContext<ContractServiceContextProps | undefined>(undefined)
ContractServiceContext.displayName = "ContractServiceContext"

export const ContractServiceProvider = ({
  children,
  storage,
  options,
}: {
  children: ReactNode
  storage: IContractServiceStorage
  options: ContractServiceOptions
}) => {
  const { obsidionWallet, currentNetwork } = useAztecContext()
  const [contractService, setContractService] = useState<ContractService | null>(null)
  // Mainnet-only hard boot error surfaced from the oxide manifest gate below.
  const [fatalError, setFatalError] = useState<Error | null>(null)
  // Suppresses state writes from an operation that outlives the provider. Declared ahead of the
  // effects that read it so a StrictMode remount restores it before any of them resume.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    const initializeContractService = async () => {
      if (!obsidionWallet || !currentNetwork) return

      const network = await NetworkStorage.get().getNetwork()
      logger.log("initializing contract service: ", network)

      let existingInstance
      try {
        existingInstance = ContractService.getInstance()
      } catch (error) {
        logger.log("Error getting ContractService instance:", error)
        existingInstance = null
      }

      if (existingInstance) {
        // Network is immutable per ContractService instance; if callers ever need
        // a different network, they should construct a new instance (not mutate).
        if (!contractService) {
          setContractService(existingInstance)
          // An adopted instance (v4 boot path installs the v4-generation
          // ContractService before this provider runs) still needs the FPC
          // PXE registrations — idempotent, so safe on any existing instance.
          await initFPC(existingInstance)
        }
        return
      }

      if (options.source === "profile") {
        // Provider-level backstop: the composition root resolves the profile against this same
        // network before it ever builds these options.
        assert(
          options.config,
          'ContractServiceProvider requires a config snapshot for source "profile"',
        )
        assert(
          options.config.network === network.type,
          `Config snapshot is for network "${options.config.network}" but the wallet is on ` +
            `"${network.type}"`,
        )
      }

      const newContractService = ContractService.getInstance(
        storage,
        obsidionWallet.node,
        obsidionWallet.pxe,
        network.type as any,
        options,
      )

      logger.log("contract service created: ", newContractService?.getNetwork())

      setContractService(newContractService)
      await initFPC(newContractService)

      try {
        const l1Addresses = await newContractService.getL1Addresses()
        if (options.onL1AddressesLoaded) {
          options.onL1AddressesLoaded(l1Addresses)
        }
      } catch (err) {
        logger.warn("Failed to load L1 addresses:", err)
      }
    }
    initializeContractService().catch((error) => {
      // The error boundary renders this; a fire-and-forget effect would otherwise swallow it.
      logger.error("Failed to construct the contract service from the config snapshot:", error)
      if (mounted.current) setFatalError(error as Error)
    })
  }, [obsidionWallet, currentNetwork])

  // Oxide env-registry lifecycle: start the client so boot-time readers that never call
  // initialize() themselves still inherit manifest values, then gate mainnet on the result.
  //
  // Nothing subscribes. A tuple-to-tuple roll moves the token address, which signals an
  // intra-rollup migration rather than a stale cache — that flow owns the response, and
  // reacting here would be a second, blinder detector for the same event.
  useEffect(() => {
    if (!contractService) return
    const client = contractService.getOxideClient()
    // No manifest for this environment (sandbox).
    if (!client) return

    let cancelled = false

    void (async () => {
      await client.initialize()
      if (cancelled) return
      // Mainnet: a wrong/partial/mismatched-gitSha manifest leaves the client
      // with no applied tuple and failureMode "manifest-incompatible". Surface a
      // hard boot error rather than silently degrading to empty address rows
      // with real funds. Gated on mainnet so testnet/sandbox are unchanged; a
      // transient "fetch-failed" is NOT fatal (the client retries).
      if (
        contractService.getNetwork() === Network.MAINNET &&
        !client.getCurrentTuple() &&
        client.getResolutionState().failureMode === "manifest-incompatible"
      ) {
        setFatalError(
          new Error(
            "Mainnet oxide manifest is incompatible (wrong schema, missing required field, or " +
              "gitSha mismatch). Refusing to boot against empty registry rows.",
          ),
        )
      }
    })()

    return () => {
      cancelled = true
    }
  }, [contractService])

  // Brick loudly on a fatal mainnet manifest incompatibility — the nearest error
  // boundary renders it instead of the app running against empty registry rows.
  if (fatalError) throw fatalError

  return (
    <ContractServiceContext.Provider value={{ contractService }}>
      {children}
    </ContractServiceContext.Provider>
  )
}

export const useContractServiceContext = (): ContractServiceContextProps => {
  const context = useContext(ContractServiceContext)
  assert(context, "useContractServiceContext must be used within a ContractServiceProvider")
  return context
}

// when we have more complexity around fpc in the future
// fpc service in client should exist in which registration is handled via service base.
const initFPC = async (contractService: ContractService) => {
  // Sponsor FPC is optional gasless-fee infra — if it isn't in the registry or
  // on-chain yet, skip its registration and continue. It must NOT abort
  // contract-service init / boot (fees just fall back to another method).
  try {
    const sponsoredFPCAddress = await contractService.getContractAddress(
      DEFAULT_CONTRACTS.sponsorFPC,
    )
    if (!sponsoredFPCAddress) {
      logger.warn("Sponsored FPC address not found in registry — skipping sponsor FPC")
    } else {
      // Guarded: no-op when the PXE already has the instance + artifact.
      await contractService.registerContractWithName(DEFAULT_CONTRACTS.sponsorFPC)
      logger.log("Sponsor FPC registered at:", sponsoredFPCAddress.toString())
    }
  } catch (e) {
    console.warn("Failed to register sponsor FPC:", e)
  }
}
