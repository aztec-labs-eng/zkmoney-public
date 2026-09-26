import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import { ContractService, Network, createNode } from "@obsidion/sdk"
import { lazy, Suspense, useEffect, useState } from "react"
import {
  AccountProvider,
  AssetProvider,
  ConfigProvider,
  LocalConfigStore,
  ContactStorage,
  IssuedConnectStorage,
  NameClaimStore,
  RequestStorage,
  ObsidionCoreProvider,
  PendingConnectBackStorage,
  PredicateScreeningService,
  ScreeningProvider,
  createOxideTeeSignerSource,
  passThroughScreener,
  useAztecContext,
  useContractServiceContext,
} from "@obsidion/front-core"
import { PrimaryGradientButton } from "@obsidion/web-ds"
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom"
import { ScanNavigationProvider } from "./features/scan/ScanNavigation"
import { getConfig, type WebBootConfig } from "./config/env"
import { isDemoMode } from "./dev/demoFlag"
import { ErrorModalHost } from "./errors/ErrorModalHost"
import { bindAnalyticsConsent } from "./lib/analytics"
import { wireTxTimingAnalytics } from "./lib/txTimingAnalytics"
import { hasWalletEntry, reportGateBounce } from "./features/identity/admission"
import { loadOnboardedIdentity, loadWalletIdentity } from "./features/identity/walletIdentity"
import { NameRequiredScreen } from "./ui/screens/NameRequiredScreen"
import {
  buildWebDetectionDeps,
  runBootDetection,
  startDetectionLoop,
  syncPendingStoreAcrossTabs,
  watchRegistrationRail,
} from "./features/onboarding/webRegistration"
import { walletResumeExtras } from "./features/onboarding/registrationResume"
import { useSponsoredRailPending } from "./features/onboarding/sponsoredRailReadiness"
import { UnlockGate } from "./features/identity/UnlockGate"
import { EnterAppScreen } from "./features/onboarding/EnterAppScreen"
import { OnboardingScreen } from "./features/onboarding/OnboardingScreen"
import { GOOGLE_CALLBACK_PATH, GoogleCallbackScreen } from "./features/paylink/googleAuth"
import { LinkViewScreen } from "./features/paylink/LinkViewScreen"
import { ClaimRoute } from "./features/paylink/PaylinkOnboardingScreen"
import { NewLinkScreen } from "./features/paylink/NewLinkScreen"
import { NewRequestLinkScreen } from "./features/requests/NewRequestLinkScreen"
import { RequestLandingScreen } from "./features/requests/RequestLandingScreen"
import { DepositScreen } from "./features/deposit/DepositScreen"
import { ReceiveScreen } from "./features/receive/ReceiveScreen"
import { ContactsScreen } from "./features/contacts/ContactsScreen"
import { SendScreen } from "./features/contacts/SendScreen"
import { ContactDetailScreen } from "./features/contacts/ContactDetailScreen"
import { ContactPayScreen } from "./features/contacts/ContactPayScreen"
import { ConnectReceiveScreen } from "./features/contacts/ConnectReceiveScreen"
import { hasConnectStash, stashInboundConnect } from "./features/contacts/connectReceive"
import { stashInboundNameGrant } from "./features/onboarding/oxideOnboarding"
import { WithdrawScreen } from "./features/withdraw/WithdrawScreen"
import { useAuthenticator } from "./platform/auth/useAuthenticator"
import { XmtpMount } from "./platform/xmtp/XmtpMount"
import { MigrationDetectionMount } from "./features/migration/MigrationDetectionMount"
import { NotificationsMount } from "./features/notifications/NotificationsMount"
import { PaylinkClaimMount } from "./features/notifications/PaylinkClaimMount"
import { TransferScannerMount } from "./platform/transactions/TransferScannerMount"
import { useSipaDeposits } from "./features/deposit/useSipaDeposits"
import { BrowserContractServiceStorage } from "./platform/contracts/BrowserContractServiceStorage"
import { contactsWriteLock, requestsWriteLock } from "./platform/storage/contactsLock"
import { webStorage } from "./platform/storage/WebStorageAdapter"
import { AppShell, SidebarLayout } from "./ui/AppShell"
import { BakedProfileNotice } from "./ui/BakedProfileNotice"
import { OnboardingLayout } from "./ui/OnboardingLayout"
import { BootSplash, PxeBootProvider, usePxeBoot } from "./ui/PxeBoot"
import { WagmiProvider } from "wagmi"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RainbowKitProvider } from "@rainbow-me/rainbowkit"
import { RainbowKitModalLayer } from "./features/deposit/RainbowKitModalLayer"
import "@rainbow-me/rainbowkit/styles.css"
import "./features/deposit/rainbowkit.css"
import { rainbowkitTheme, wagmiConfig } from "./features/deposit/wagmi"

const queryClient = new QueryClient()

// The profiling overlay and everything it pulls in (canvas waterfall, the interceptors) sit behind
// a literal env comparison, so a default build folds this to null and never emits the chunk. The
// flag has to be spelled inline here rather than imported: a re-exported const does not fold
// across modules, and the dead lazy import is emitted as a chunk anyway (src/profiling/README.md).
const ProfilePanel =
  import.meta.env.VITE_PROFILER === "true"
    ? lazy(() => import("./profiling/ProfilePanel").then((m) => ({ default: m.ProfilePanel })))
    : null
import { ActivityScreen } from "./ui/screens/ActivityScreen"
import { HomeScreen } from "./ui/screens/HomeScreen"
import { NotFoundScreen } from "./ui/screens/NotFoundScreen"
import { SettingsScreen } from "./ui/screens/SettingsScreen"
import { LeaveGuardMount } from "./features/operations/LeaveGuardMount"
import { OperationsMount } from "./features/operations/OperationsMount"

/**
 * Everything the provider tree needs, created on the App's first render (not
 * at module import) so a config error renders through the error boundary in
 * `main.tsx` instead of white-screening. References stay stable for the app's
 * lifetime — `useAsset` reconnects if the TEE signer source identity changes.
 */
function createAppServices() {
  const config = getConfig()
  const storageAdapter = webStorage
  const node = createNode(config.nodeUrl, config.nodeApiKey)
  // Construct the ContactStorage singleton first so it carries the cross-tab write lock and the
  // storage-event invalidation seam; ObsidionCoreProvider's later get() reuses this instance.
  ContactStorage.get(storageAdapter, contactsWriteLock)
  // Per-device ledger of minted handshake codes (Share @tag); screens reuse via get(). Shares the
  // contacts-write lock (distinct storage keys, one mutex) so two tabs' writes serialize.
  IssuedConnectStorage.get(storageAdapter, undefined, contactsWriteLock)
  // Outbox of connect-backs awaiting the U9 XMTP flusher; the /connect confirm enqueues here.
  PendingConnectBackStorage.get(storageAdapter, undefined, contactsWriteLock)
  // Cache of the L1 NameClaim artifacts that gate ClaimFPC eligibility; recoverable from the
  // Registry's log, so it is seeded here purely so later get() calls need no adapter.
  NameClaimStore.get(storageAdapter)
  // P2P payment requests — the receiver writes and the request UI observe the same instance.
  RequestStorage.get(storageAdapter, requestsWriteLock)
  return {
    config,
    storageAdapter,
    configService: new LocalConfigStore(storageAdapter),
    contractServiceStorage: new BrowserContractServiceStorage(config.network),
    // L1 address screening (withdraw recipient, deposit EOA). Unconfigured builds pass everything.
    screener: config.predicate
      ? new PredicateScreeningService(config.predicate)
      : passThroughScreener,
    // TEE co-signer for oxide-token operations. Portal comes from the oxide
    // tuple; an empty `config.enclaveUrl` dials the manifest's own enclaveUrl.
    assetOptions: {
      // Without this seed TokenStorage stays empty and
      // every loadAssets short-circuits to an empty asset list — no balance.
      initialTokensToLoad: [WALLET_TOKEN_SYMBOL],
      teeSignerSource: createOxideTeeSignerSource({
        l1RpcUrl: config.l1RpcUrl,
        l1Chain: config.l1Chain,
        transformEnclaveUrl: (url) => (config.enclaveUrl ? `${config.enclaveUrl}/rpc` : url),
        // The pinned enclave must be approved on the active token before it is handed to the
        // services. Same node the PXE boots against; the token resolves once the contract
        // service is up, so the connect skips until then.
        getNode: () => node,
        getTokenAddress: async () => {
          try {
            return await ContractService.getInstance().getContractAddress("oxideToken")
          } catch {
            return undefined // getInstance throws before the provider constructs the singleton
          }
        },
      }),
    },
    // The one client, created here and handed to everything that needs one.
    node,
  }
}

/**
 * Non-deferrable lost-race/completion detection on app load — credential-free (a read-only
 * account-service client + public RPC), so it runs before and independent of unlock. A pending
 * identity is retracted if the name was lost and settled once the Registry confirms; the tag
 * presentation gate stays in claiming-in-progress until this first tick settles. The detection
 * loop then keeps polling while a record is open, so an in-session claim settles without a reload.
 * Once the wallet is up, the loop also carries the unlocked session's sign deps, so a broadcast
 * that never mined is re-sent in the background instead of waiting on a user gesture.
 */
function RegistrationDetectionMount() {
  const { obsidionWallet } = useAztecContext()
  useEffect(() => {
    void runBootDetection(getConfig()).catch(() => {})
  }, [])
  useEffect(() => syncPendingStoreAcrossTabs(), [])
  useEffect(() => watchRegistrationRail(), [])
  useEffect(() => {
    const config = getConfig()
    return startDetectionLoop(
      config,
      obsidionWallet
        ? {
            buildDeps: () =>
              buildWebDetectionDeps(config, walletResumeExtras(config, obsidionWallet)),
          }
        : {},
    )
  }, [obsidionWallet])
  return null
}

/**
 * PXE boot gate + AccountProvider for every surface. Waits for the PXE and the
 * contract service, then mounts AccountProvider so onboarding, paylink and
 * wallet screens all drive the shared front-core contexts (useAccount,
 * useAssetContext).
 */
function AccountGate() {
  const { bootStatus, retryBoot } = usePxeBoot()
  const { contractService } = useContractServiceContext()

  if (bootStatus === "error")
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 16,
          padding: "24px 16px",
          maxWidth: 430,
          margin: "0 auto",
        }}
      >
        <PrimaryGradientButton title="Retry" onClick={retryBoot} />
      </div>
    )
  // Demo mode never boots a PXE, so no contract service is ever created.
  if (bootStatus === "booting" || (!contractService && !isDemoMode())) return <BootSplash />
  return (
    <AccountProvider useAuthenticator={useAuthenticator}>
      <Outlet />
    </AccountProvider>
  )
}

const DemoEmptyBalance = import.meta.env.DEV
  ? lazy(() => import("./dev/DemoEmptyBalance"))
  : () => null

/**
 * The asset layer (token service, balances, TEE-signer connect) — mounted only
 * around the wallet + paylink surfaces that consume it. Onboarding stays out of
 * it on purpose: running `useAsset`'s PXE work (token registration, balance
 * sync, TEE connect) alongside the sponsored account-setup tx starves it on the
 * single-threaded browser PXE, which hangs onboarding on slower machines. A
 * signup a payment link funds is the exception: its claim needs this layer, so
 * the link page and ClaimRoute host that wizard inside it.
 */
function AssetGate({
  assetOptions,
}: {
  assetOptions: ReturnType<typeof createAppServices>["assetOptions"]
}) {
  return (
    <AssetProvider assetOptions={assetOptions}>
      {import.meta.env.DEV && isDemoMode() && (
        <Suspense fallback={null}>
          <DemoEmptyBalance />
        </Suspense>
      )}
      <Outlet />
    </AssetProvider>
  )
}

function SipaDepositsMount() {
  useSipaDeposits()
  return null
}

/**
 * Wallet routes require an entered identity (a name is NOT required — nameless
 * accounts are prompted to register from Home), waitlist admission (granted, or
 * a confirmed registration — the paid queue-skip), and an unlocked MSK: a
 * refresh reopens from the cached key, and UnlockGate holds the surface behind a
 * passkey re-assert when there is none. Visitors failing the first two go to
 * /claim, whose steps (invite, pending-deposit) are the right surface for both.
 */
function WalletGate() {
  const location = useLocation()
  if (!loadOnboardedIdentity() || !hasWalletEntry()) {
    // An onboarded identity refused entry is the queued-user bounce ULT-777 counts; a visitor
    // with no identity is just not signed up yet.
    if (loadOnboardedIdentity()) reportGateBounce()
    return <Navigate to="/claim" replace />
  }
  // A stashed inbound connect replays once the gates pass — e.g. after onboarding routed
  // away from /connect. The stash is consume-once, so this fires at most one redirect.
  if (location.pathname !== "/connect" && hasConnectStash()) {
    return <Navigate to="/connect" replace />
  }
  return (
    <UnlockGate>
      {/* Unlocked only: the lock/visibility-scoped XMTP client + stage-2 inbox. Demo mode has no
          network identity to register, so it renders the seeded stores as-is. */}
      {!isDemoMode() && <XmtpMount />}
      <NotificationsMount />
      {!isDemoMode() && <PaylinkClaimMount />}
      {/* Chain-native incoming-transfer ingest — independent of XMTP and the leader lock. */}
      {!isDemoMode() && <TransferScannerMount />}
      {/* The SIPA sync loop runs on every wallet route, so an open deposit sheet advances anywhere. */}
      <SipaDepositsMount />
      <Outlet />
      {/* Funds-gated: pops "Migration detected" when a retired deployment still holds value.
          Last so it stacks above any route-level sheet (same z-index, later in DOM). */}
      <MigrationDetectionMount />
    </UnlockGate>
  )
}

/**
 * Routes whose only rail is ClaimFPC-sponsored. That rail admits an account the L1 registry
 * registered, so a nameless account cannot pay for any of them, and a just-registered one cannot
 * until the NamePortal's L1->L2 message reaches the rollup. Both blocks land here, on the attempt,
 * and say why — rather than hiding the action up front or letting the flow fail at the fee.
 */
export function NameGate() {
  const identity = loadWalletIdentity()
  const registrationPending = useSponsoredRailPending()
  if (identity && !identity.handle) return <NameRequiredScreen />
  // Demo mode never creates the wallet services needed to check registration.
  if (!isDemoMode()) {
    // Not yet known: the services are booting or the first L1 read is in flight. A registered
    // account spends a few seconds here on every cold load, so it reads as loading, not pending.
    if (registrationPending === undefined) return <BootSplash inShell />
    if (registrationPending) return <NameRequiredScreen pending />
  }
  return <Outlet />
}

export function App({ boot }: { boot: WebBootConfig }) {
  const [services] = useState(createAppServices)
  // Stash an inbound /connect packet before any gate redirect can drop the fragment.
  useState(stashInboundConnect)
  // Retain an inbound name grant before routing, and keep the bearer token out of URL history.
  useState(stashInboundNameGrant)
  // Config hydrates before the rest of the tree (and so before PXE boot):
  // the future remote layer feeds endpoints into that very boot path.
  const [configReady, setConfigReady] = useState(false)
  useEffect(() => {
    void services.configService.init().then(() => {
      // Bound before first render so even pre-route events (PXE boot) are consent-gated.
      bindAnalyticsConsent(() => services.configService.get("analyticsConsent"))
      wireTxTimingAnalytics()
      setConfigReady(true)
    })
  }, [services])
  if (!configReady) return null
  return (
    // No reconnect on load: a session reads no wallet until the user connects.
    <WagmiProvider config={wagmiConfig()} reconnectOnMount={false}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={rainbowkitTheme} modalSize="compact">
          <RainbowKitModalLayer>
            <ConfigProvider service={services.configService}>
              <ObsidionCoreProvider
                networkConfig={{
                  activeNetwork: services.config.network,
                  nodeUrl: services.config.nodeUrl,
                  nodeApiKey: services.config.nodeApiKey,
                  l1RpcUrl: services.config.l1RpcUrl,
                  // NetworkStorage only builds the mainnet row when this is set; without it a
                  // mainnet build has no current network and getNetwork() throws at boot.
                  enableMainnet: services.config.network === Network.MAINNET,
                }}
                storageAdapter={services.storageAdapter}
                contractServiceStorage={services.contractServiceStorage}
                contractServiceOptions={boot.contractServiceOptions}
              >
                <RegistrationDetectionMount />
                <LeaveGuardMount />
                {ProfilePanel && (
                  <Suspense fallback={null}>
                    <ProfilePanel />
                  </Suspense>
                )}
                <PxeBootProvider node={services.node}>
                  <OperationsMount node={services.node} />
                  <BrowserRouter>
                    {/* L1 address screening (withdraw recipient, deposit EOA, registration payer) on every route. */}
                    <ScanNavigationProvider>
                      <ScreeningProvider screener={services.screener}>
                        <Routes>
                          {/* Google's OAuth redirect (email-locked paylink claims) — outside AppShell AND the
                  PXE gate on purpose: it renders in a popup that only relays the token to its
                  opener, so booting a PXE there would be a multi-second stall for a window about to
                  close. */}
                          <Route path={GOOGLE_CALLBACK_PATH} element={<GoogleCallbackScreen />} />
                          <Route
                            element={
                              <AppShell
                                notice={
                                  boot.bootedFromBakedProfile && boot.bakedProfile ? (
                                    <BakedProfileNotice
                                      publishedAt={boot.bakedProfile.publishedAt}
                                    />
                                  ) : undefined
                                }
                              />
                            }
                          >
                            {/* Payment-request link entry. The page itself sits outside AccountGate so
                      the SIPA pay-QR paints before PXE is up; the accountless right pane
                      nests AccountGate + the existing /claim wizard (OnboardingScreen). */}
                            <Route
                              path="request"
                              element={<RequestLandingScreen node={services.node} />}
                            >
                              <Route element={<AccountGate />}>
                                <Route index element={<OnboardingScreen embedded />} />
                              </Route>
                            </Route>
                            {/* PXE-gated; AccountProvider (useAccount) for every surface. */}
                            <Route element={<AccountGate />}>
                              {/* Onboarding needs only useAccount — kept out of the asset layer, except the
                        resume of a registration a payment link funds (ClaimRoute). The signup wizard
                        is full-bleed (it carries its own invitation chrome). */}
                              <Route
                                path="claim/:handle?"
                                element={<ClaimRoute assetOptions={services.assetOptions} />}
                              />
                              <Route path="enter" element={<EnterAppScreen />} />
                              {/* Wallet + paylink surfaces additionally mount the asset layer. */}
                              <Route element={<AssetGate assetOptions={services.assetOptions} />}>
                                {/* Wallet surface: desktop sidebar shell; requires a claimed identity +
                          unlocked MSK (WalletGate renders the unlock pane inside the shell). */}
                                <Route
                                  element={
                                    <SidebarLayout
                                      mobilePageHeaderPaths={["/contacts", "/connect"]}
                                      enablePhoneScan
                                    />
                                  }
                                >
                                  <Route element={<WalletGate />}>
                                    <Route index element={<HomeScreen />} />
                                    <Route path="activity" element={<ActivityScreen />} />
                                    <Route path="settings" element={<SettingsScreen />} />
                                    <Route path="receive" element={<ReceiveScreen />} />
                                    <Route path="contacts" element={<ContactsScreen />} />
                                    <Route path="connect" element={<ConnectReceiveScreen />} />
                                    <Route
                                      path="contacts/:idOrTag"
                                      element={<ContactDetailScreen />}
                                    />
                                    <Route element={<NameGate />}>
                                      <Route path="links/new" element={<NewLinkScreen />} />
                                      <Route
                                        path="requests/new"
                                        element={<NewRequestLinkScreen />}
                                      />
                                      <Route path="deposit" element={<DepositScreen />} />
                                      <Route path="send" element={<SendScreen />} />
                                      <Route
                                        path="contacts/:idOrTag/send"
                                        element={<ContactPayScreen mode="send" />}
                                      />
                                      <Route path="withdraw" element={<WithdrawScreen />} />
                                    </Route>
                                  </Route>
                                </Route>
                                {/* Link view is identity-free but needs the asset layer to claim. */}
                                <Route path="link" element={<LinkViewScreen />} />
                              </Route>
                            </Route>
                            {/* Unknown routes: branded 404 outside the PXE gate — no boot splash for a dead URL. */}
                            <Route element={<OnboardingLayout />}>
                              <Route path="*" element={<NotFoundScreen />} />
                            </Route>
                          </Route>
                        </Routes>
                      </ScreeningProvider>
                    </ScanNavigationProvider>
                  </BrowserRouter>
                  {/* Global error/info modal — any catch block surfaces it via showErrorModal(). */}
                  <ErrorModalHost />
                </PxeBootProvider>
              </ObsidionCoreProvider>
            </ConfigProvider>
          </RainbowKitModalLayer>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
