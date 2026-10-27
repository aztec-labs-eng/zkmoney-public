import { createContext, useContext, ReactNode, useEffect, useState } from "react"

import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { ExtendedViemWalletClient } from "@aztec-labs/ethereum/types"
import {
  ObsidionWallet,
  ObsidionAlphaTestWallet,
  Network,
  type IPendingTxStore,
} from "@obsidion/sdk"
import { l1ChainIdForNetwork } from "@obsidion/core/constants"
import type { ChainIdentity } from "@obsidion/core/types"
import {
  NetworkStorage,
  type NetworkConfig,
  setActiveGenerationNode,
  setActiveNetworkId,
  getNodeApiKey,
} from "src/core"
import { assert } from "ts-essentials"
import { PXE } from "@aztec-labs/pxe/client/lazy"
import { getPXEConfig } from "@aztec-labs/pxe/config"
import { createLogger } from "@aztec-labs/foundation/log"
import type { PrivateKernelProver } from "@aztec-labs/stdlib/interfaces/client"
import type { AztecAsyncKVStore } from "@aztec-labs/kv-store"
import type { CircuitSimulator } from "@aztec-labs/simulator/client"
import { logger } from "src/utils/logger"

/** Options for {@link AztecContextProps.initializePXE}: build the wallet over the node the caller owns. */
export interface InitializePXEOptions {
  /** Explicit client-proving override; defaults per-network when unset. */
  proverEnabled?: boolean
  /** The client this wallet talks to. Whoever owns it passes it in; this module never builds one. */
  node: AztecNode
  prover?: PrivateKernelProver
  /** Where the PXE's own prover loads bb.js's wasm, when the caller serves it; ignored beside `prover`. */
  bbWasmPath?: string
  store?: AztecAsyncKVStore
  simulator?: CircuitSimulator
  /**
   * Encrypted persistent `PendingTxStore`, constructed by the platform. Unset leaves the wallet on
   * its `InMemoryPendingTxStore` default.
   */
  pendingTxStore?: IPendingTxStore
  /**
   * The identity boot verified against L1. Pinned into the wallet's chain info and published as the
   * active network id; unset, both come from the node's own answer.
   */
  chainIdentity?: ChainIdentity
}

interface AztecContextProps {
  obsidionWallet: ObsidionWallet | undefined
  // pxe: PXE | null
  // aztecNode: AztecNode | null
  l1Client: ExtendedViemWalletClient | null
  networkStatus: NetworkStatus | null
  currentNetwork: NetworkConfig | null
  networks: NetworkConfig[]
  setNetworks: (networks: NetworkConfig[]) => void
  rollupAddress: string
  // setPXE: (pxe: PXE | null) => void
  initializePXE: (opts: InitializePXEOptions) => Promise<PXE | undefined>
}

type NetworkStatus = "stable" | "unstable"

const AztecContext = createContext<AztecContextProps | undefined>(undefined)

export const AztecProvider = ({
  children,
  isTestAccount,
}: {
  children: ReactNode
  isTestAccount?: boolean
}) => {
  const [obsidionWallet, setObsidionWallet] = useState<ObsidionWallet | undefined>()
  // const [pxe, setPXE] = useState<PXE | null>(null)
  // const [aztecNode, setAztecNode] = useState<AztecNode | null>(null)
  const [l1Client, setL1Client] = useState<ExtendedViemWalletClient | null>(null)
  const [networkStatus, setNetworkStatus] = useState<NetworkStatus | null>(null)

  const [networks, setNetworks] = useState<NetworkConfig[]>([])
  const [currentNetwork, setCurrentNetwork] = useState<NetworkConfig | null>(null)
  const [rollupAddress, setRollupAddress] = useState<string>("")

  // Load networks from storage on initial load
  useEffect(() => {
    const loadNetworks = async () => {
      const storedNetworks = await NetworkStorage.get().getAllNetworkConfigs()
      setNetworks(Object.values(storedNetworks))

      const current = Object.values(storedNetworks).find((n) => n.current)
      if (current) {
        setCurrentNetwork(current)
      }
    }

    loadNetworks()
  }, [])

  const initializePXE = async (opts: InitializePXEOptions) => {
    const customProver = opts.prover
    const customStore = opts.store
    const customSimulator = opts.simulator
    const customPendingTxStore = opts.pendingTxStore
    const chainIdentity = opts.chainIdentity
    // if (pxe) return // Already initialized

    if (obsidionWallet) return // Already initialized

    const network = currentNetwork
    logger.log("network", network)
    if (!network) return
    logger.log("network found")

    // const fetch = makeFetch([1, 1, 1, 2, 4, 8], false)
    // const fetch = makeFetch([1, 1, 1, 2, 4, 8], false)

    // Prod = not the local sandbox (testnet AND mainnet enable the prover
    // and the production tx timeout). Per-network `l1ChainId` comes from
    // `l1ChainIdForNetwork` below rather than off this flag.
    const isProd = network.type !== Network.SANDBOX
    logger.log("isProd", isProd)
    try {
      // console.time("createPXEService")

      // const node = createAztecNodeClient(network.nodeUrl, {}, fetch)
      const node = opts.node
      // setAztecNode(node)
      logger.log("node created")

      let newPxe: PXE | undefined
      {
        // Create browser-compatible PXE using client/lazy (imported at top).
        // An explicit override wins (the web wallet proves for real against
        // sandbox); otherwise enable proving for prod or whenever a prover is
        // injected, so sandbox boots exercise it instead of submitting an empty proof.
        const proverEnabled = opts.proverEnabled ?? (isProd || !!customProver)

        const pxeConfig = Object.assign(getPXEConfig(), {
          proverEnabled,
          // proveTx perf logs only when a prover/store/simulator is injected.
          proveTxPerfLogs: !!customProver || !!customStore || !!customSimulator,
          l1ChainId: l1ChainIdForNetwork(network.type),
        })

        const WalletClass = isTestAccount ? ObsidionAlphaTestWallet : ObsidionWallet
        // Forward the persistent pendingTxStore into the wallet so `sendTx`
        // writes records into the same store the `TxLifecycleService` reads.
        const obsidionWallet = await WalletClass.create(
          node,
          pxeConfig,
          {
            loggers: {
              pxe: createLogger("pxe"),
              store: createLogger("pxe:store"),
              prover: createLogger("pxe:prover"),
            },
            proverOrOptions:
              customProver ?? (opts.bbWasmPath ? { wasmPath: opts.bbWasmPath } : undefined),
            store: customStore,
            simulator: customSimulator,
          },
          {
            pendingTxStore: customPendingTxStore,
            chainInfo: chainIdentity && {
              l1ChainId: chainIdentity.l1ChainId,
              rollupVersion: Number(chainIdentity.rollupVersion),
            },
          },
        )
        newPxe = obsidionWallet.pxe
        setObsidionWallet(obsidionWallet)
        setActiveGenerationNode(obsidionWallet.node)

        const rollup =
          chainIdentity?.rollupAddress ??
          (await obsidionWallet.node.getNodeInfo()).l1ContractAddresses.rollupAddress.toString()
        setRollupAddress(rollup)
        setActiveNetworkId(rollup)
      }

      // Create a promise that rejects after 10 seconds
      // const timeoutPromise = new Promise((_, reject) => {
      //   setTimeout(() => reject(new Error("PXE connection timeout after 10 seconds")), 10000)
      // })
      // const timeoutPromise = new Promise((_, reject) => {
      //   setTimeout(() => reject(new Error("PXE connection timeout after 10 seconds")), 10000)
      // })

      // // Race between the waitForPXE and the timeout
      // await Promise.race([waitForPXE(newPxe), timeoutPromise])
      // console.timeEnd("createPXEService")
      // // Race between the waitForPXE and the timeout
      // await Promise.race([waitForPXE(newPxe), timeoutPromise])
      // console.timeEnd("createPXEService")

      setNetworkStatus("stable")
      return newPxe
    } catch (error) {
      // console.error("Error initializing PXE", error)
      // setNetworkStatus("unstable")
      // throw error // Propagate the error so callers know initialization failed
      logger.error("Error initializing PXE")
      logger.error("Error type:", error?.constructor?.name)

      // Log all enumerable properties of the error
      if (error && typeof error === "object") {
        logger.error(
          "Error properties:",
          JSON.stringify(error, Object.getOwnPropertyNames(error), 2),
        )
      }

      // Also log the raw error
      logger.error("Raw error:", error)

      setNetworkStatus("unstable")
      throw error
    }
  }

  return (
    <AztecContext.Provider
      value={{
        obsidionWallet,
        l1Client,
        networkStatus,
        currentNetwork,
        networks,
        setNetworks,
        rollupAddress,
        initializePXE,
      }}
    >
      {children}
    </AztecContext.Provider>
  )
}

export const useAztecContext = () => {
  const context = useContext(AztecContext)
  assert(context, "useAztecContext must be used within an AztecProvider")
  return context
}
