/**
 * Only the active tab mounts the wallet: the one holding the active-tab lock and its databases
 * (`activeTabLifecycle.ts`). Any other tab says so and can take over.
 */
import { useEffect, useRef, useState, type ReactNode } from "react"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { BlockNumber } from "@aztec-labs/foundation/branded-types"
import { NoRetryError, makeBackoff, retry } from "@aztec-labs/foundation/retry"
import type { AztecSQLiteOPFSStore } from "@aztec-labs/kv-store/sqlite-opfs"
import type { ChainIdentity } from "@obsidion/core/types"
import { WalletError, stageIdentity, useStore } from "@obsidion/front-core"
import { createNode } from "@obsidion/sdk"
import { PrimaryGradientButton, Spinner } from "@obsidion/web-ds"
import { App, type ActiveTabBoot } from "../App"
import { isDemoMode } from "../dev/demoFlag"
import { ErrorModalHost } from "../errors/ErrorModalHost"
import { discardIncompatiblePasskeyState } from "../platform/auth/discardIncompatiblePasskeyState"
import { bindSavedConsent } from "../lib/bootConsent"
import { warmSyncBackend } from "../platform/barretenberg"
import { bindWalletAuth } from "../platform/auth/useAuthenticator"
import { accountsOfSession, activeNamespace, sessionLoaded } from "../session/session"
import type { Page, PageBoot } from "../app/sessionDeps"
import { activateTab, revokeTab, sendOnlyWhileActive } from "../platform/storage/activeTab"
import { ActiveTabLifecycle, type ActiveTabDeps } from "../platform/storage/activeTabLifecycle"
import { createPxeStore, opfsAvailable } from "../platform/storage/createPxeStore"
import { originWasFresh } from "../platform/storage/freshOrigin"
import { carryRetiredConfig } from "../platform/storage/retiredConfig"
import { removeOldWalletKeys } from "../platform/storage/storageMigrations/oldLocalStorage"
import {
  closeWalletStore,
  isWalletOpenElsewhere,
  openWalletStore,
  reloadPage,
} from "../platform/storage/walletStorage"
import { createWallet } from "../platform/wallet"
import { BootErrorScreen } from "../ui/BootErrorScreen"
import {
  BootSplash,
  assertCustomL1RpcSimulates,
  bootWaitsForStart,
  describeBootError,
  identityReads,
  isPayPath,
  reportBootFailure,
  verifiedIdentity,
  type PxeBootTarget,
} from "../ui/PxeBoot"
import copy from "./ActiveTabGate.copy"

interface OpenedWallet {
  node: AztecNode
  pxeBoot: Extract<PxeBootTarget, { kind: "pxe" }>
  close(): Promise<void>
}

/** Another tab holds a database. */
const isBusy = (e: unknown): boolean =>
  e instanceof Error && (isWalletOpenElsewhere(e) || isBusy(e.cause))

/** Seconds between attempts at a PXE store open that failed for a reason other than a held store. */
const PXE_OPEN_BACKOFF_S = [1, 1, 2]

/** The page's claim of the tab; `bootStartedAt` is when it first tried to open its databases. */
export interface ActiveTabHold {
  lifecycle?: ActiveTabLifecycle<OpenedWallet>
  bootStartedAt?: number
  attempts: number
}

/** Under the rollup L1 names, and a custom node's under its own digest, so no two nodes share one. */
async function openPxeStore(
  identity: ChainIdentity,
  nodeDigest: string | undefined,
  hold: ActiveTabHold,
): Promise<AztecSQLiteOPFSStore> {
  hold.attempts = 0
  return retry(
    () => {
      hold.attempts++
      return createPxeStore(identity.rollupAddress, nodeDigest).catch((e: unknown) => {
        throw isBusy(e) ? new NoRetryError(String(e), { cause: e }) : e
      })
    },
    "pxe store open",
    makeBackoff(PXE_OPEN_BACKOFF_S),
  )
}

function walletDeps(page: Page): ActiveTabDeps<OpenedWallet> {
  const { config } = page
  const node = sendOnlyWhileActive(createNode(config.nodeUrl, config.nodeApiKey))
  let reads: ReturnType<typeof identityReads> | undefined
  let identity: Promise<ChainIdentity> | undefined
  let l1RpcSimulates: Promise<void> | undefined
  // The genesis block and hashing WASM the PXE starts with.
  const warmPxe = () => {
    void node.getBlock(BlockNumber.ZERO)
    void warmSyncBackend()
  }
  return {
    locks: (navigator as Navigator & { locks?: LockManager }).locks,
    // The wallet database first: the PXE store is only worth opening for a wallet this tab holds.
    open: async () => {
      const startedAt = (page.activeTab.bootStartedAt ??= performance.now())
      // None of these needs a store, so they load while the stores open: the chain reads the
      // identity check judges, and the PXE's warmup. Whether a pay page's boot waits reads the
      // session's identity, so its warmup waits for `prepare`.
      reads ??= identityReads(config, node)
      if (!isPayPath(location.pathname)) warmPxe()
      // The fresh-origin check must not see this page's own database.
      await originWasFresh()
      await openWalletStore(config.profileRollupVersion, { persistent: await opfsAvailable() })
      try {
        // A retired database's preferences first: the device load carries older builds'
        // `localStorage` copies only into keys still absent.
        await carryRetiredConfig(page.database)
        await page.device.load()
        // A boot failure reports under the saved consent, which the wallet database holds.
        bindSavedConsent(page.device)
        // Checked once per page, after consent is bound so the check's events are sent. The wallet
        // database is named after the profile's rollup, which the check holds to L1's.
        identity ??= verifiedIdentity(config, node, reads)
        l1RpcSimulates ??= assertCustomL1RpcSimulates(config)
        const [verified] = await Promise.all([identity, l1RpcSimulates])
        const store = await openPxeStore(verified, config.nodeEndpointDigest, page.activeTab)
        return {
          node,
          pxeBoot: {
            kind: "pxe",
            store,
            identity: verified,
            bootStartedAt: startedAt,
            attempts: page.activeTab.attempts,
          },
          close: async () => {
            try {
              await store.close()
            } finally {
              await closeWalletStore()
            }
          },
        }
      } catch (e) {
        await closeWalletStore()
        throw e
      }
    },
    isBusy,
    // After both opens, so an older-build tab still holding the PXE store keeps its state meanwhile.
    // Nothing reads those keys, so a failed removal is left to the next activation or logout.
    prepare: async (opened) => {
      try {
        removeOldWalletKeys(config.profileRollupVersion)
      } catch (e) {
        console.warn("[ActiveTabGate] could not remove old wallet keys:", e)
      }
      await discardIncompatiblePasskeyState(page.database, page.device, config.rpId, (w) =>
        stageIdentity(w, activeNamespace(page.device).prefix, null),
      )
      await page.auth.findRetiredSession()
      page.openWallet(opened.node, opened.pxeBoot, createWallet(config, page.pace, page.prover))
      bindWalletAuth(page.auth, page.wallet, accountsOfSession)
      const session = page.switchTo(activeNamespace(page.device))
      // The tag's pending state derives from these stores, and the first render reads them. A
      // failed open is the store's `failed` view.
      await sessionLoaded(session)
      const path = location.pathname
      if (isPayPath(path) && !bootWaitsForStart(session.identity.get(), path)) warmPxe()
      page.activeSince.set(Date.now())
    },
    activate: activateTab,
    revoke: revokeTab,
    reload: () => void reloadPage(),
  }
}

/** Builds the page's tab lifecycle, which takes the active-tab lock. The boot calls it once. */
export function claimActiveTab(page: Page): void {
  const lifecycle = new ActiveTabLifecycle(walletDeps(page))
  page.activeTab.lifecycle = lifecycle
  lifecycle.start()
}

export function ActiveTabGate({ boot }: { boot: PageBoot }) {
  // Retain an inbound name grant and take the bearer token out of the URL, even in a tab that
  // waits on the other-tab screen.
  useState(() => boot.page.signup.stashInbound())
  return isDemoMode() ? <DemoWallet boot={boot} /> : <ActiveTabWallet boot={boot} />
}

/**
 * Demo mode boots no PXE and takes no lock: its wallet database is in memory and belongs to this
 * page alone. The tab counts as active from page load.
 */
function DemoWallet({ boot }: { boot: PageBoot }) {
  const [activeTab] = useState<ActiveTabBoot>(() => {
    const { config } = boot.page
    return {
      node: createNode(config.nodeUrl, config.nodeApiKey),
      pxeBoot: { kind: "demo" },
    }
  })
  return <App boot={boot} activeTab={activeTab} />
}

function ActiveTabWallet({ boot }: { boot: PageBoot }) {
  const tab = boot.page.activeTab.lifecycle
  if (!tab) throw new WalletError("invariant", "ActiveTabWallet: the boot claimed no tab")
  const state = useStore(tab.state)

  switch (state.kind) {
    case "starting":
      return <BootSplash />
    case "inactive":
      return (
        <TabNotice title={copy.otherTab}>
          <p style={{ margin: 0 }}>{copy.otherTabBody}</p>
          <PrimaryGradientButton
            title={copy.useThisTab}
            isLoading={state.claiming}
            onClick={tab.takeOver}
          />
        </TabNotice>
      )
    case "opening":
      if (!state.takeover && !state.stalled) return <BootSplash />
      return (
        <TabNotice title={state.takeover ? copy.switching : copy.loading}>
          <Spinner size={28} />
          {state.stalled && <p style={{ margin: 0 }}>{copy.stalled}</p>}
        </TabNotice>
      )
    case "ready":
      return (
        <App
          boot={boot}
          activeTab={{
            node: state.opened.node,
            pxeBoot: state.opened.pxeBoot,
          }}
        />
      )
    case "displaced":
      // Only while this page closes its databases, before it reloads.
      return (
        <TabNotice title={copy.otherTab}>
          <Spinner size={28} />
        </TabNotice>
      )
    case "failed":
      return <BootFailure error={state.error} page={boot.page} />
    default: {
      const unhandled: never = state
      throw new WalletError(
        "invariant",
        `ActiveTabWallet: unhandled state ${(unhandled as { kind: string }).kind}`,
      )
    }
  }
}

function TabNotice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px 16px",
        boxSizing: "border-box",
        background: "var(--surface-dark)",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 16,
          maxWidth: 400,
          textAlign: "center",
          color: "var(--text-secondary)",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 22, color: "var(--text-primary)" }}>{title}</h1>
        {children}
      </div>
    </div>
  )
}

function BootFailure({ error, page }: { error: unknown; page: Page }) {
  const { config, activeTab } = page
  const shown = useRef(false)
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (shown.current) return
    shown.current = true
    reportBootFailure(error, config, activeTab)
  }, [error, config, activeTab])
  return (
    <>
      {/* A failed boot ends this page's run as the active tab for good, so a retry is a new page. */}
      <BootErrorScreen
        error={describeBootError(error, config)}
        onRetry={() => void reloadPage()}
        walletOpen={false}
        config={config}
      />
      <ErrorModalHost network={config.network} />
    </>
  )
}
