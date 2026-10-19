import {
  L1IdentityUnavailableError,
  NodeIdentityMismatchError,
  PortalIdentityMismatchError,
  profileRollupSkew,
  useAztecContext,
  verifyNodeIdentity,
  type InitializePXEOptions,
  type NodeIdentityField,
  type NodeIdentityInfo,
} from "@obsidion/front-core"
import { readPortalChainIdentity } from "@obsidion/sdk"
import { L1RpcSimulationUnsupportedError, assertL1RpcSimulates } from "@obsidion/core/oxide"
import type { ChainIdentity } from "@obsidion/core/types"
import type { ReactNode } from "react"
import type { AztecNode } from "@aztec/aztec.js/node"
import { SqliteCorruptionError, type AztecSQLiteOPFSStore } from "@aztec/kv-store/sqlite-opfs"
import type { Hex } from "viem"
import { useLocation } from "react-router-dom"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react"
import { getConfig, type WebWalletConfig } from "../config/env"
import { l1PublicClient } from "../config/oxideTuple"
import { outOfMemoryCopy, showReportableError } from "../errors/errorModal"
import { loadWalletIdentity } from "../features/identity/walletIdentity"
import { networkHasSwapStack } from "../features/withdraw/freshAddressAvailability"
import { fireEvent } from "../lib/analytics"
import { createExternalState } from "../lib/externalState"
import { provingDevice } from "../lib/provingDevice"
import { barretenbergWasm } from "../platform/bbWasmPath"
import { isActiveTab } from "../platform/storage/activeTab"
import { reloadPage } from "../platform/storage/walletStorage"

/** `idle`: the boot waits for a screen that needs it (`bootWaitsForDemand`). */
type BootStatus = "idle" | "booting" | "ready" | "error"

export type BootErrorKind =
  | "mismatch"
  | "profile-skew"
  | "l1-unavailable"
  | "l1-rpc-no-simulate"
  | "unreachable"
  | "corrupt"
  | "other"

/** Why the boot stopped, worded for the persistent error screen. */
export interface BootError {
  kind: BootErrorKind
  /** The disagreeing field on a mismatch: a node field, or `l1RpcChainId` for a wrong-chain RPC. */
  field?: NodeIdentityField | "l1RpcChainId"
  title: string
  message: string
}

interface PxeBootState {
  bootStatus: BootStatus
  bootError?: BootError
  /** Retry a failed boot, by reloading the page. */
  retryBoot: () => void
  /** Start an idle boot. */
  demandBoot: () => void
}

const PxeBootContext = createContext<PxeBootState>({
  bootStatus: "booting",
  retryBoot: () => {},
  demandBoot: () => {},
})

export function usePxeBoot() {
  return useContext(PxeBootContext)
}

/**
 * The config profile's rollup version is not the pinned one. The wallet database is named after the
 * profile's version and the PXE store after the pinned identity, so booting would split wallet state.
 */
class ProfileRollupSkewError extends Error {
  constructor(readonly profile: string, readonly pinned: string) {
    super(`config profile says rollupVersion ${profile}, the wallet is pinned to ${pinned}`)
    this.name = "ProfileRollupSkewError"
  }
}

/** Refuses a pinned identity the profile disagrees with, and reports the skew. */
function assertProfileAgrees(config: WebWalletConfig, identity: ChainIdentity): ChainIdentity {
  const skew = profileRollupSkew(config.profileRollupVersion, identity)
  if (!skew) return identity
  fireEvent("profile_rollup_skew", {
    profile_version: Number(skew.profile),
    l1_version: Number(skew.l1),
  })
  throw new ProfileRollupSkewError(skew.profile, skew.l1)
}

/** The node did not answer a request; the transport error rides as `cause`. */
class NodeUnreachableError extends Error {
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

function identityFromNode(info: NodeIdentityInfo): ChainIdentity {
  return {
    l1ChainId: info.l1ChainId,
    rollupVersion: String(info.rollupVersion),
    rollupAddress: info.l1ContractAddresses.rollupAddress.toString().toLowerCase(),
    inboxAddress: info.l1ContractAddresses.inboxAddress.toString().toLowerCase(),
  }
}

// The node client has no request timeout, so a node that accepts the connection and never answers
// would hold the boot forever; the L1 reads carry their own.
const NODE_READ_TIMEOUT_MS = 30_000

function withinDeadline<T>(read: Promise<T>, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} did not answer`)),
      NODE_READ_TIMEOUT_MS,
    )
    read.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

/**
 * The L1 and node reads `verifiedIdentity` judges. They fire no events, so a boot can start them
 * before consent is bound.
 */
export function identityReads(config: WebWalletConfig, node: AztecNode) {
  return Promise.allSettled([
    readPortalChainIdentity(
      l1PublicClient(config),
      config.oxideProfile.portal as Hex,
      config.l1ChainId,
    ),
    withinDeadline(node.getNodeInfo(), "getNodeInfo"),
  ])
}

/**
 * The identity the wallet boots on. L1 is the source and the node must agree with it. Only the
 * default node may boot on its own answers, and only when L1 yields no identity at all and the
 * node names this network's chain: a wrong-chain RPC or a disagreeing node refuses whichever node
 * it is, and a custom node refuses on anything but agreement.
 */
export async function verifiedIdentity(
  config: WebWalletConfig,
  node: AztecNode,
  reads = identityReads(config, node),
): Promise<ChainIdentity> {
  const [l1, info] = await reads
  // A wrong-chain RPC is the more specific finding, whatever the node did.
  if (l1.status === "rejected" && l1.reason instanceof PortalIdentityMismatchError) throw l1.reason
  if (info.status === "rejected") throw new NodeUnreachableError(info.reason)
  if (l1.status === "fulfilled") {
    verifyNodeIdentity({ nodeInfo: info.value, expected: l1.value })
    return assertProfileAgrees(config, l1.value)
  }
  const failure: unknown = l1.reason
  if (!(failure instanceof L1IdentityUnavailableError) || !config.endpoints.node.isDefault) {
    throw failure
  }
  // The chain id needs no L1 read, so a default node on another chain is refused even now.
  if (info.value.l1ChainId !== config.l1ChainId) {
    throw new NodeIdentityMismatchError({
      field: "l1ChainId",
      expected: config.l1ChainId,
      got: info.value.l1ChainId,
    })
  }
  console.error("L1 identity read failed; the default node boots on its own answers", failure.cause)
  fireEvent("node_identity_unverified", { call: failure.call })
  return assertProfileAgrees(config, identityFromNode(info.value))
}

/** Default RPCs are checked at build and publish; custom RPCs must pass at boot. */
export async function assertCustomL1RpcSimulates(config: WebWalletConfig): Promise<void> {
  if (config.endpoints.l1Rpc.isDefault || !networkHasSwapStack(config.network)) return
  await assertL1RpcSimulates(config.l1RpcUrl)
}

/**
 * The store takes one PXE, so the PXE is created exactly once per page load even under
 * StrictMode's double-mounted effects: the in-flight promise is shared.
 */
let bootPromise: Promise<void> | undefined

function bootOnce(
  initializePXE: (opts: InitializePXEOptions) => Promise<unknown>,
  node: AztecNode,
  { store, identity, bootStartedAt, attempts }: Extract<PxeBootTarget, { kind: "pxe" }>,
) {
  bootPromise ??= (async () => {
    await initializePXE({
      node,
      proverEnabled: getConfig().proverEnabled,
      // The boot's bb.js, so the first proof downloads it no second time.
      bbWasmPath: barretenbergWasm().wasmPath,
      store,
      chainIdentity: identity,
    }).catch((e: unknown) => {
      throw isNodeFetchFailure(e) ? new NodeUnreachableError(e) : e
    })
    fireEvent("pxe_boot_completed", {
      duration_ms: Math.round(performance.now() - bootStartedAt),
      attempts,
      ...provingDevice(),
    })
  })()
  return bootPromise
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
    const reloads = Number(sessionStorage.getItem(DOWNLOAD_RELOADS_KEY)) || 0
    if (reloads >= MAX_DOWNLOAD_RELOADS) return false
    sessionStorage.setItem(DOWNLOAD_RELOADS_KEY, String(reloads + 1))
    return true
  } catch {
    return false
  }
}

function clearDownloadReloads(): void {
  try {
    sessionStorage.removeItem(DOWNLOAD_RELOADS_KEY)
  } catch {
    return
  }
}

/** The default L1 RPC carries its provider key in the path; a URL the user typed is theirs to see. */
function shownL1Rpc(config: WebWalletConfig): string {
  if (!config.endpoints.l1Rpc.isDefault) return config.l1RpcUrl
  try {
    return new URL(config.l1RpcUrl).host
  } catch {
    return config.l1RpcUrl
  }
}

const isCorrupt = (e: unknown): boolean =>
  e instanceof SqliteCorruptionError || (e instanceof AggregateError && e.errors.some(isCorrupt))

/** A title names the endpoint at fault, when the boot knows it, so the user knows which to change. */
export function describeBootError(e: unknown): BootError {
  if (e instanceof NodeIdentityMismatchError) {
    // The chain id is the network's constant, which L1 need not have answered.
    const expected =
      e.field === "l1ChainId" ? `this network is chain ${e.expected}` : `L1 says ${e.expected}`
    return {
      kind: "mismatch",
      field: e.field,
      title: `The node at ${getConfig().nodeUrl} is not on this rollup`,
      message: `It reports ${e.field} ${e.got}; ${expected}. The wallet does not use a node that disagrees with L1.`,
    }
  }
  if (e instanceof ProfileRollupSkewError) {
    // Only a custom node or RPC can make the pinned version the user's doing; the enclave cannot.
    const { node, l1Rpc } = getConfig().endpoints
    const custom = !node.isDefault || !l1Rpc.isDefault
    return {
      kind: "profile-skew",
      field: "rollupVersion",
      title: "This wallet's configuration disagrees with L1",
      message:
        `The config profile names rollup version ${e.profile}; the rollup is on ${e.pinned}. ` +
        "The wallet stops rather than file your data under the wrong rollup. " +
        (custom
          ? "Your custom node or Ethereum RPC may be pointing at another rollup: go back to the defaults."
          : "The operator needs to publish a corrected profile."),
    }
  }
  if (e instanceof PortalIdentityMismatchError) {
    return {
      kind: "mismatch",
      field: e.field,
      title: `The Ethereum RPC at ${shownL1Rpc(getConfig())} is on the wrong chain`,
      message: `It answered chain id ${e.got}; this network is chain ${e.expected}.`,
    }
  }
  if (e instanceof L1RpcSimulationUnsupportedError) {
    return {
      kind: "l1-rpc-no-simulate",
      title: `The Ethereum RPC at ${shownL1Rpc(getConfig())} can't price withdrawals`,
      message:
        "It does not support eth_simulateV1, which the wallet needs to price a withdrawal to USDC, USDT or ETH. " +
        "Use an RPC that supports it, or go back to the default.",
    }
  }
  if (e instanceof L1IdentityUnavailableError) {
    const config = getConfig()
    return {
      kind: "l1-unavailable",
      title: `The Ethereum RPC at ${shownL1Rpc(config)} gave no rollup identity`,
      message: `Its ${e.call} read failed, so the node at ${config.nodeUrl} could not be checked against L1. A custom node only boots once L1 confirms it.`,
    }
  }
  if (e instanceof NodeUnreachableError) {
    return {
      kind: "unreachable",
      title: "zk.money cannot reach the network",
      message: "Check your internet connection, then retry.",
    }
  }
  if (isCorrupt(e)) {
    return {
      kind: "corrupt",
      title: "zk.money's data on this browser is damaged",
      message:
        "The wallet cannot read its database here, and retrying does not repair it. To use zk.money on this browser again, clear its wallet data.",
    }
  }
  const outOfMemory = outOfMemoryCopy(e)
  if (outOfMemory) return { kind: "other", title: outOfMemory.title, message: outOfMemory.message }
  return {
    kind: "other",
    title: "zk.money failed to start",
    message: e instanceof Error ? e.message : String(e),
  }
}

/**
 * Reports a failed boot to analytics, and to the user when no screen explains it. `bootStartedAt`
 * is unset when the boot failed before it began; `attempts` counts the opens of the PXE store it took.
 */
export function reportBootFailure(
  e: unknown,
  { bootStartedAt, attempts }: { bootStartedAt: number | undefined; attempts: number },
): void {
  const { kind, title } = describeBootError(e)
  fireEvent("pxe_boot_failed", {
    duration_ms:
      bootStartedAt === undefined ? undefined : Math.round(performance.now() - bootStartedAt),
    code: kind,
    attempts,
  })
  // The inline copy names no cause; devtools keeps the transport error.
  if (e instanceof NodeUnreachableError) console.error(e.message, e.cause)
  // The identity refusals render in place with their exits.
  if (kind === "other")
    showReportableError(e, "pxe:boot", {
      title,
      retry: { label: "Reload page", run: () => void reloadPage() },
    })
}

/** The store the active tab opened for the PXE, or none in demo mode, which boots no PXE. */
export type PxeBootTarget =
  | { kind: "demo" }
  | {
      kind: "pxe"
      store: AztecSQLiteOPFSStore
      /** Checked against L1 before the store opened; the wallet is pinned to it. */
      identity: ChainIdentity
      /** `performance.now()` when the boot began, for the boot's duration. */
      bootStartedAt: number
      /** Opens of the store it took. */
      attempts: number
    }

/** The pay page, and the older request-link entry. */
export const isPayPath = (pathname: string): boolean =>
  /^\/(?:pay\/[^/]+|request)\/?$/.test(pathname)

/**
 * A signed-out visitor on a pay page shows nothing the PXE serves, so the boot waits until a screen
 * needs it. Reads the wallet database, so only once it is open.
 */
export function bootWaitsForDemand(pathname = location.pathname): boolean {
  return isPayPath(pathname) && !loadWalletIdentity()
}

/**
 * Kicks off PXE init on the store the active tab opened. MUST sit inside ObsidionCoreProvider but
 * OUTSIDE ObsidionAppProvider: the app provider renders null until the contract service exists,
 * which needs the wallet `initializePXE` creates — mounting the initializer underneath it
 * deadlocks into a black screen.
 */
export function PxeBootProvider({
  node,
  pxeBoot,
  children,
}: {
  node: AztecNode
  pxeBoot: PxeBootTarget
  children: ReactNode
}) {
  const { currentNetwork, initializePXE } = useAztecContext()
  const [demanded, setDemanded] = useState(() => pxeBoot.kind === "demo" || !bootWaitsForDemand())
  const [state, setState] = useState<Omit<PxeBootState, "retryBoot" | "demandBoot">>({
    bootStatus: demanded ? "booting" : "idle",
  })

  useEffect(() => {
    // Demo mode opens no store and boots no PXE — its fixtures are already in storage.
    if (pxeBoot.kind === "demo") {
      setState({ bootStatus: "ready" })
      return
    }
    // initializePXE silently no-ops until AztecProvider has loaded the network
    // from storage — wait for it or the boot "succeeds" with no wallet.
    if (!currentNetwork || !demanded) return
    setState((s) => (s.bootStatus === "idle" ? { bootStatus: "booting" } : s))
    let cancelled = false
    bootOnce(initializePXE, node, pxeBoot)
      // A tab another tab took over while this one booted publishes nothing: it is reloading, and
      // closed the store under the PXE, so a failure is expected.
      .then(() => {
        clearDownloadReloads()
        if (!cancelled && isActiveTab()) setState({ bootStatus: "ready" })
      })
      .catch((e: unknown) => {
        if (cancelled || !isActiveTab()) return
        if (isModuleDownloadFailure(e) && takeDownloadReload()) return void reloadPage()
        reportBootFailure(e, pxeBoot)
        setState({ bootStatus: "error", bootError: describeBootError(e) })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot once the network is known
  }, [currentNetwork, demanded])

  // A failed boot may have half-built the wallet's services, which live for the page.
  const retryBoot = useCallback(() => void reloadPage(), [])
  const demandBoot = useCallback(() => setDemanded(true), [])

  return (
    <PxeBootContext.Provider value={{ ...state, retryBoot, demandBoot }}>
      {children}
    </PxeBootContext.Provider>
  )
}

/** Inside the router: demands the boot on any route where it does not wait. */
export function BootDemand() {
  const { pathname } = useLocation()
  const { bootStatus, demandBoot } = usePxeBoot()
  useEffect(() => {
    if (bootStatus === "idle" && !bootWaitsForDemand(pathname)) demandBoot()
  }, [bootStatus, pathname, demandBoot])
  return null
}

const mountedSplashes: { inShell: boolean }[] = []
let bootScreenShown = false
/** The app has drawn its first screen, so a screen standing in for it must go. */
const firstScreen = createExternalState(false)

export function useFirstScreenShown(): boolean {
  return useSyncExternalStore(firstScreen.subscribe, firstScreen.get)
}

const rootShowsText = () => {
  const root = document.getElementById("root")
  return (root?.innerText ?? root?.textContent ?? "").trim() !== ""
}
let splashWatch: number | undefined
let splashLeaving: ReturnType<typeof setTimeout> | undefined

/** The splash's fade in index.html. */
const SPLASH_FADE_MS = 200
/** Longest the splash waits, with no copy mounted, for the next screen to show anything. */
const SPLASH_MAX_WAIT_MS = 3_000

const VISUALLY_HIDDEN = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
} as const

function showSplash(): void {
  cancelAnimationFrame(splashWatch ?? 0)
  clearTimeout(splashLeaving)
  delete document.body.dataset.bootLeaving
  // Until the first screen, every wait is the boot screen; after it, a shell's wait keeps the shell.
  const full = !bootScreenShown || mountedSplashes.some((copy) => !copy.inShell)
  document.body.dataset.booting = full ? "full" : "shell"
}

/**
 * The last copy has gone, but the next stage may still be a render or a redirect away from showing
 * anything. The splash stays until the page has text to show, then fades.
 */
function releaseSplash(): void {
  const since = performance.now()
  // Once this commit has settled, before it paints: a screen that replaced the last copy takes over
  // from a stand-in at once, so the two never show together. The stand-in hid the boot screen, so
  // it ends with no fade.
  queueMicrotask(() => {
    if (mountedSplashes.length > 0 || !rootShowsText()) return
    if (document.getElementById("pre-boot")?.hasChildNodes()) {
      cancelAnimationFrame(splashWatch ?? 0)
      bootScreenShown = true
      delete document.body.dataset.booting
      delete document.body.dataset.bootLeaving
    }
    firstScreen.set(true)
  })
  const watch = () => {
    const shown = rootShowsText()
    if (!shown && performance.now() - since < SPLASH_MAX_WAIT_MS) {
      splashWatch = requestAnimationFrame(watch)
      return
    }
    bootScreenShown = true
    firstScreen.set(true)
    document.body.dataset.bootLeaving = ""
    splashLeaving = setTimeout(() => {
      delete document.body.dataset.booting
      delete document.body.dataset.bootLeaving
    }, SPLASH_FADE_MS)
  }
  splashWatch = requestAnimationFrame(watch)
}

/**
 * The wait before any screen exists. It draws nothing itself: while any copy is mounted, the document
 * keeps up the boot screen index.html paints before any script runs. That one element spins from
 * first paint to the first screen, so a hand-off between gates never restarts or moves it.
 * `inShell` is a wait inside a mounted shell, which after the first screen keeps the shell in view.
 */
export function BootSplash({ inShell = false }: { inShell?: boolean }) {
  useLayoutEffect(() => {
    const copy = { inShell }
    mountedSplashes.push(copy)
    showSplash()
    return () => {
      mountedSplashes.splice(mountedSplashes.indexOf(copy), 1)
      if (mountedSplashes.length > 0) showSplash()
      else releaseSplash()
    }
  }, [inShell])
  return <span style={VISUALLY_HIDDEN}>Loading zk.money…</span>
}
