/**
 * The page's wallet: one PXE per page, over the store the active tab opened. It boots once the page
 * wants it, so a pay page boots nothing until a screen needs it. A failed boot waits for a reload.
 */
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { createLogger } from "@aztec-labs/foundation/log"
import type { Pace } from "@obsidion/core/cadence"
import { l1ChainIdForNetwork } from "@obsidion/core/constants"
import {
  derived,
  memoryStore,
  service,
  WalletError,
  type ReadonlyStore,
  type Service,
} from "@obsidion/front-core"
import { ObsidionWallet, type ContractServiceFactory, type SendTurns } from "@obsidion/sdk"
import type { WebWalletConfig } from "../config/env"
import { fireEvent } from "../lib/analytics"
import { provingDevice } from "../lib/provingDevice"
import type { PxeBootTarget } from "../ui/PxeBoot"
import { barretenbergWasm } from "./barretenberg"
import { isActiveTab } from "./storage/activeTab"
import { tabStash } from "./storage/tabStash"
import { reloadPage } from "./storage/walletStorage"

export type PxeTarget = Extract<PxeBootTarget, { kind: "pxe" }>
/** `bb` is the page's bb.js options, which the PXE's prover starts on. */
export type CreateWallet = (
  node: AztecNode,
  target: PxeTarget,
  bb: ReturnType<typeof barretenbergWasm>,
  contractService: ContractServiceFactory,
) => Promise<ObsidionWallet>

/** The node did not answer a request; the transport error rides as `cause`. */
export class NodeUnreachableError extends Error {
  constructor(cause: unknown) {
    super("node did not answer", { cause })
    this.name = "NodeUnreachableError"
  }
}

function isNodeFetchFailure(e: unknown): boolean {
  const rpcError = e instanceof Error ? e.cause : undefined
  return (
    typeof rpcError === "object" &&
    rpcError !== null &&
    "data" in rpcError &&
    rpcError.data instanceof Error
  )
}

const DOWNLOAD_RELOADS_KEY = "pxeBoot.downloadReloads"
const MAX_DOWNLOAD_RELOADS = 2
const MODULE_DOWNLOAD_FAILURE =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/

function isModuleDownloadFailure(e: unknown): boolean {
  if (e instanceof AggregateError) return e.errors.some(isModuleDownloadFailure)
  return e instanceof TypeError && MODULE_DOWNLOAD_FAILURE.test(e.message)
}

function takeDownloadReload(): boolean {
  try {
    const reloads = Number(tabStash.get(DOWNLOAD_RELOADS_KEY)) || 0
    if (reloads >= MAX_DOWNLOAD_RELOADS) return false
    tabStash.set(DOWNLOAD_RELOADS_KEY, String(reloads + 1))
    return true
  } catch {
    return false
  }
}

function clearDownloadReloads(): void {
  try {
    tabStash.remove(DOWNLOAD_RELOADS_KEY)
  } catch {
    return
  }
}

/**
 * The wallet pinned to the identity the active tab checked against L1, its waits on `pace` and its
 * sends on the page's `prover`.
 */
export const createWallet =
  (config: WebWalletConfig, pace: Pace, prover: SendTurns): CreateWallet =>
  (node, { store, identity }, bb, contractService) => {
    const pxeConfig = {
      proverEnabled: config.proverEnabled,
      proveTxPerfLogs: true,
      l1ChainId: l1ChainIdForNetwork(config.network),
    }
    return ObsidionWallet.create(
      node,
      pxeConfig,
      {
        loggers: {
          pxe: createLogger("pxe"),
          store: createLogger("pxe:store"),
          prover: createLogger("pxe:prover"),
        },
        // The boot's bb.js, so the first proof downloads it no second time.
        proverOrOptions: bb,
        store,
      },
      {
        chainInfo: { l1ChainId: identity.l1ChainId, rollupVersion: Number(identity.rollupVersion) },
        networkId: identity.rollupAddress,
        pace,
        prover,
        contractService,
      },
    )
  }

/** Never settles: the page is reloading, so the boot stays pending. */
const reloading = () => new Promise<never>(() => {})

/**
 * Boots the PXE. A tab another tab took over while it booted keeps it pending: it is reloading, and
 * closed the store under the PXE, so a failure is expected. A failed module download reloads the
 * page, twice at most.
 */
async function boot(
  node: AztecNode,
  target: PxeTarget,
  create: CreateWallet,
  contractService: ContractServiceFactory,
) {
  try {
    const wallet = await create(node, target, barretenbergWasm(), contractService)
    fireEvent("pxe_boot_completed", {
      duration_ms: Math.round(performance.now() - target.bootStartedAt),
      attempts: target.attempts,
      ...provingDevice(),
    })
    clearDownloadReloads()
    return isActiveTab() ? wallet : reloading()
  } catch (e) {
    if (!isActiveTab()) return reloading()
    const error = isNodeFetchFailure(e) ? new NodeUnreachableError(e) : e
    if (isModuleDownloadFailure(error) && takeDownloadReload()) {
      void reloadPage()
      return reloading()
    }
    throw error
  }
}

/** The page's wallet, the no-wallet stand-in until the active tab opens its store. */
export interface PageWallet {
  /** Pending until the page wants it over an opened store: demo mode opens none. `ready()` wants it. */
  wallet: Service<ObsidionWallet>
  /** The rollup address the wallet is pinned to, once it is built. */
  networkId: ReadonlyStore<string | undefined>
  /** The page wants the wallet; the PXE boots while it holds. */
  walletWanted: ReadonlyStore<boolean>
  /** The boot asks for the wallet. Before `openWallet` it asks for nothing. */
  wantWallet(): void
  /** Builds the wallet over the active tab's store; the first call wins. */
  openWallet(node: AztecNode, target: PxeTarget, create: CreateWallet): void
}

/** A want before the store opens boots nothing, even once it opens. */
export function createPageWallet(contractService: ContractServiceFactory): PageWallet {
  const wanted = memoryStore(false)
  const opened = memoryStore<(() => Promise<ObsidionWallet>) | undefined>(undefined)
  const wallet = service(
    "wallet",
    { from: [], when: wanted.readonly, dispose: (w) => w.pxe.stop(), retry: "manual" },
    () => {
      const open = opened.get()
      if (!open) throw new WalletError("invariant", "the wallet is wanted before its store opened")
      return open()
    },
  )
  const wantWallet = () => void (opened.get() && wanted.set(true))
  return {
    // A flow that waits for the wallet asks for it, as a boot screen does.
    wallet: { ...wallet, ready: (signal) => (wantWallet(), wallet.ready(signal)) },
    networkId: derived([wallet], (s) => (s.status === "ready" ? s.value.networkId : undefined)),
    walletWanted: wanted.readonly,
    wantWallet,
    openWallet(node, target, create) {
      if (!opened.get()) opened.set(() => boot(node, target, create, contractService))
    },
  }
}
