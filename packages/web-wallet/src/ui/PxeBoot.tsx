import { useAztecContext, type InitializePXEOptions } from "@obsidion/front-core"
import { Spinner } from "@obsidion/web-ds"
import type { ReactNode } from "react"
import type { AztecNode } from "@aztec/aztec.js/node"
import { createContext, useCallback, useContext, useEffect, useState } from "react"
import { getConfig } from "../config/env"
import { isDemoMode } from "../dev/demoFlag"
import { showErrorModal, showReportableError } from "../errors/errorModal"
import { failureCode, fireEvent, lapTimer } from "../lib/analytics"
import { createPxeStore } from "../platform/storage/createPxeStore"

type BootStatus = "booting" | "ready" | "error"

interface PxeBootState {
  bootStatus: BootStatus
  bootError?: string
  /** Re-attempt a failed boot (e.g. the node was unreachable). */
  retryBoot: () => void
}

const PxeBootContext = createContext<PxeBootState>({
  bootStatus: "booting",
  retryBoot: () => {},
})

export function usePxeBoot() {
  return useContext(PxeBootContext)
}

/**
 * The OPFS SAH pool takes an exclusive lock on its directory, so the store +
 * PXE must be created exactly once per page load even under StrictMode's
 * double-mounted effects — the in-flight promise is shared, and only a
 * FAILED boot clears it so a retry can re-attempt.
 */
let bootPromise: Promise<void> | undefined

function bootOnce(
  initializePXE: (opts: InitializePXEOptions) => Promise<unknown>,
  node: AztecNode,
) {
  bootPromise ??= (async () => {
    const elapsed = lapTimer()
    let store: Awaited<ReturnType<typeof createPxeStore>> | undefined
    try {
      const config = getConfig()
      // An unreachable node rejects here (after the client's built-in retries) and surfaces as a
      // boot error with a retry, before the OPFS pool lock is taken.
      const { rollupAddress } = await node.getL1ContractAddresses()
      store = await createPxeStore(rollupAddress.toString())
      // The same client the pre-boot read used, so the wallet does not build a second one.
      await initializePXE({ node, proverEnabled: config.proverEnabled, store })
      fireEvent("pxe_boot_completed", { duration_ms: elapsed() })
    } catch (e) {
      // Release the OPFS pool lock, or every retry after a post-open failure
      // collides with our own leaked store.
      await store?.close().catch(() => {})
      bootPromise = undefined
      fireEvent("pxe_boot_failed", { duration_ms: elapsed(), code: failureCode(e) })
      throw e
    }
  })()
  return bootPromise
}

/**
 * The OPFS pool lock is origin-wide, so this fires when zk.money is already
 * open in another tab. Name check instead of instanceof — the bundle may
 * carry more than one @aztec/kv-store instance.
 */
function isPoolBusy(e: unknown): boolean {
  return e instanceof Error && e.name === "SqlitePoolBusyError"
}

/**
 * Kicks off PXE init. MUST sit inside ObsidionCoreProvider but OUTSIDE
 * ObsidionAppProvider: the app provider renders null until the contract
 * service exists, which needs the wallet `initializePXE` creates — mounting
 * the initializer underneath it deadlocks into a black screen.
 */
export function PxeBootProvider({ node, children }: { node: AztecNode; children: ReactNode }) {
  const { currentNetwork, initializePXE } = useAztecContext()
  const [state, setState] = useState<Omit<PxeBootState, "retryBoot">>({ bootStatus: "booting" })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    // Demo mode has no node to boot against — its fixtures are already in storage.
    if (isDemoMode()) {
      setState({ bootStatus: "ready" })
      return
    }
    // initializePXE silently no-ops until AztecProvider has loaded the network
    // from storage — wait for it or the boot "succeeds" with no wallet.
    if (!currentNetwork) return
    let cancelled = false
    setState({ bootStatus: "booting" })
    bootOnce(initializePXE, node)
      .then(() => !cancelled && setState({ bootStatus: "ready" }))
      .catch((e: unknown) => {
        if (cancelled) return
        if (isPoolBusy(e)) {
          showErrorModal({
            title: "zk.money is already open",
            message:
              "You can only have zk.money running in one tab at a time — sorry for the inconvenience! Close the other tab, then retry.",
            context: "pxe:boot",
          })
        } else {
          showReportableError(e, "pxe:boot", { title: "PXE failed to start" })
        }
        setState({ bootStatus: "error", bootError: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot when the network is known; `attempt` re-runs a failed boot
  }, [currentNetwork, attempt])

  const retryBoot = useCallback(() => setAttempt((n) => n + 1), [])

  return (
    <PxeBootContext.Provider value={{ ...state, retryBoot }}>{children}</PxeBootContext.Provider>
  )
}

/**
 * The wait before any screen exists. Several gates can show it in turn on one cold load, so it
 * owns its surface and fills the viewport itself: identical in each, on the same background the
 * document already paints, which is what makes the hand-offs read as one spinner rather than
 * several on moving ground. `inShell` is the same wait inside a mounted shell, whose canvas is
 * already on screen: it fills the content column and paints no surface of its own.
 */
export function BootSplash({ inShell = false }: { inShell?: boolean }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        ...(inShell ? {} : { minHeight: "100dvh", background: "var(--surface-dark)" }),
      }}
    >
      <Spinner size={28} />
      <span style={{ color: "var(--text-secondary)" }}>Loading zk.money…</span>
    </div>
  )
}
