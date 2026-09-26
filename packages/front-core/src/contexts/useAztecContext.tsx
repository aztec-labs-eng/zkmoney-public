import { createContext, useContext, ReactNode, useEffect, useState } from "react"

import type { AztecNode } from "@aztec/aztec.js/node"
import type { ExtendedViemWalletClient } from "@aztec/ethereum/types"
import {
  ObsidionWallet,
  ObsidionAlphaTestWallet,
  Network,
  type IPendingTxStore,
} from "@obsidion/sdk"
import { l1ChainIdForNetwork } from "@obsidion/core/constants"
import {
  NetworkStorage,
  type NetworkConfig,
  generationStorePrefix,
  manifestCanonicalVersion,
  setActiveGenerationNode,
  setActiveNetworkId,
  getNodeApiKey,
} from "src/core"
import { assert } from "ts-essentials"
import { PXE } from "@aztec/pxe/client/lazy"
import { getPXEConfig } from "@aztec/pxe/config"
import { createLogger } from "@aztec/foundation/log"
import type { PrivateKernelProver } from "@aztec/stdlib/interfaces/client"
import type { AztecAsyncKVStore } from "@aztec/kv-store"
import type { CircuitSimulator } from "@aztec/simulator/client"
import { logger } from "src/utils/logger"

/**
 * Options for {@link AztecContextProps.initializePXE}.
 *
 * Two ways in, and no third: adopt a wallet that already has a node, or supply the node to build
 * one over. Neither is optional, so a caller cannot reach this without having decided which node it
 * means, and the wallet's client is always one a caller owns rather than one this module invented.
 */
export type InitializePXEOptions = AdoptWalletOptions | BuildWalletOptions

interface CommonInitializePXEOptions {
  /** Explicit client-proving override; defaults per-network when unset. */
  proverEnabled?: boolean
}

/**
 * Adopt a pre-built wallet instead of constructing one here; its node came with it. The generation
 * seam: when the canonical generation's `stack` is "v4", the platform layer builds the wallet from
 * the v4-origin sdk create path (whose @aztec/* resolve to 4.3.0) and hands it in —
 * this module's own runtime imports are the current (5.0.1) stack and must not touch a v4 node.
 */
interface AdoptWalletOptions extends CommonInitializePXEOptions {
  wallet: ObsidionWallet
  /** The adopted wallet brought its own; supplying another would silently go unused. */
  node?: never
  prover?: never
  store?: never
  simulator?: never
  pendingTxStore?: never
}

/** Build the wallet here, over the node the caller owns. */
interface BuildWalletOptions extends CommonInitializePXEOptions {
  wallet?: never
  /** The client this wallet talks to. Whoever owns it passes it in; this module never builds one. */
  node: AztecNode
  prover?: PrivateKernelProver
  store?: AztecAsyncKVStore
  simulator?: CircuitSimulator
  /**
   * Encrypted persistent `PendingTxStore`, constructed by the platform. Unset leaves the wallet on
   * its `InMemoryPendingTxStore` default.
   */
  pendingTxStore?: IPendingTxStore
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
  /** Adopt a wallet, or build one over the caller's node — see {@link InitializePXEOptions}. */
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
      // Adoption path: the caller already built the wallet through a
      // generation-specific create (v4 boot). Skip construction, keep the
      // same context wiring.
      if (opts.wallet) {
        setObsidionWallet(opts.wallet)
        // Publish this generation's node so front-core node-RPC callers use it
        // instead of a fresh 5.0.1 client (which can't talk to a v4 node).
        setActiveGenerationNode(opts.wallet.node)
        const nodeInfo = await opts.wallet.node.getNodeInfo()
        const rollup = nodeInfo.l1ContractAddresses.rollupAddress.toString()
        setRollupAddress(rollup)
        setActiveNetworkId(rollup)
        setNetworkStatus("stable")
        return opts.wallet.pxe
      }

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
          // Store keyed by generation×network — each generation runs its own
          // PXE store. Boot uses the manifest's canonical version; detection
          // drives re-init on a cutover flip (generationRegistry).
          dataDirectory: generationStorePrefix(manifestCanonicalVersion(), network.name),
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
            proverOrOptions: customProver,
            store: customStore,
            simulator: customSimulator,
          },
          { pendingTxStore: customPendingTxStore },
        )
        newPxe = obsidionWallet.pxe
        setObsidionWallet(obsidionWallet)
        setActiveGenerationNode(obsidionWallet.node)

        const nodeInfo = await obsidionWallet.node.getNodeInfo()
        const rollup = nodeInfo.l1ContractAddresses.rollupAddress.toString()
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
