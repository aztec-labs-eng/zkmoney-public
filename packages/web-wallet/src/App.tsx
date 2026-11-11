import { setPerfLogFlag, TokenService } from "@obsidion/sdk"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react"
import {
  ScreeningProvider,
  serviceStatus,
  useStore,
  type ReadonlyStore,
  type ServiceState,
} from "@obsidion/front-core"
import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useOutlet,
} from "react-router-dom"
import { ScanNavigationProvider } from "./features/scan/ScanNavigation"
import type { PageBoot } from "./app/sessionDeps"
import { proveTxPerfLogsEnabled } from "./config/features"
import { isDemoMode } from "./dev/demoFlag"
import { ErrorModalHost } from "./errors/ErrorModalHost"
import { bindAnalyticsConsent } from "./lib/analytics"
import { wireTxTimingAnalytics } from "./lib/txTimingAnalytics"
import { enteredIdentity } from "./session/account"
import { NameRequiredScreen } from "./ui/screens/NameRequiredScreen"
import { BalanceMovingScreen } from "./features/backupPasskey/BalanceMovingScreen"
import { LinkWaitsScreen } from "./features/backupPasskey/LinkWaitsScreen"
import { useActionVerdict, type WalletAction } from "./features/actionGate"
import { openMigrationDialog } from "./features/migration/migrationDialog"
import { UnlockGate } from "./features/identity/UnlockGate/UnlockGate"
import { EnterAppScreen } from "./features/onboarding/EnterAppScreen/EnterAppScreen"
import { useNameClaimPending } from "./features/registration/openRegistration"
import { OnboardingScreen } from "./features/onboarding/OnboardingScreen/OnboardingScreen"
import { LinkViewScreen } from "./features/paylink/LinkViewScreen"
import { ClaimRoute } from "./features/paylink/PaylinkOnboardingScreen"
import { NewLinkScreen } from "./features/paylink/NewLinkScreen/NewLinkScreen"
import { RequestLandingScreen } from "./features/requests/RequestLandingScreen"
import { NonContactRequestsScreen } from "./features/requests/NonContactRequestsScreen"
import { RequestsScreen } from "./features/requests/RequestsScreen/RequestsScreen"
import { NON_CONTACT_REQUESTS_PATH, REQUESTS_PATH } from "./features/requests/nonContactView"
import { DepositScreen } from "./features/deposit/DepositScreen/DepositScreen"
import { claimChosenName } from "./features/onboarding/oxideOnboarding"
import { ReceiveScreen } from "./features/receive/ReceiveScreen"
import { ContactsScreen } from "./features/contacts/ContactsScreen/ContactsScreen"
import { SendScreen } from "./features/contacts/SendScreen/SendScreen"
import { ContactDetailScreen } from "./features/contacts/ContactDetailScreen/ContactDetailScreen"
import { ContactPayScreen } from "./features/contacts/ContactPayScreen/ContactPayScreen"
import { ConnectReceiveScreen } from "./features/contacts/ConnectReceiveScreen"
import { hasConnectStash, stashInboundConnect } from "./features/contacts/connectReceive"
import { tabStash } from "./platform/storage/tabStash"
import { WithdrawMethodScreen } from "./features/withdraw/WithdrawMethodScreen/WithdrawMethodScreen"
import { OldVersionWithdrawScreen } from "./features/withdraw/OldVersionWithdrawScreen"
import { XmtpMount } from "./platform/xmtp/XmtpMount"
import { MigrationDetectionMount } from "./features/migration/MigrationDetectionMount/MigrationDetectionMount"
import { useStartAssets, useSession } from "./session/session"
import { BackupRotationMount } from "./features/backupPasskey/BackupRotationMount"
import { getDesktopSettingsPath } from "./platform/desktopBridge"
import { AppShell, SidebarLayout } from "./ui/AppShell/AppShell"
import { BakedProfileNotice, CustomProfileNotice } from "./ui/ConfigNotice"
import { BootErrorScreen } from "./ui/BootErrorScreen"
import { PreBootRouterBridge, type PreBoot } from "./session/preBoot"
import {
  BootStarter,
  BootSplash,
  PxeBootProvider,
  usePxeBoot,
  type PxeBootTarget,
} from "./ui/PxeBoot"
import { WagmiProvider } from "wagmi"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RainbowKitProvider } from "@rainbow-me/rainbowkit"
import { RainbowKitModalLayer } from "./features/deposit/RainbowKitModalLayer"
import "@rainbow-me/rainbowkit/styles.css"
import "./features/deposit/rainbowkit.css"
import { rainbowkitTheme } from "./session/wagmi"

// eslint-disable-next-line no-restricted-syntax -- debt
const queryClient = new QueryClient()

// The profiling overlay and everything it pulls in (canvas waterfall, the interceptors) sit behind
// a literal env comparison, so a default build folds this to null and never emits the chunk. The
// flag has to be spelled inline here rather than imported: a re-exported const does not fold
// across modules, and the dead lazy import is emitted as a chunk anyway (src/profiling/README.md).
const ProfilePanel =
  import.meta.env.VITE_PROFILER === "true"
    ? lazy(() => import("./profiling/ProfilePanel").then((m) => ({ default: m.ProfilePanel })))
    : null
// Dev `/dev/mock/<area>/<name>` pages; a production build folds this to null and drops the chunk.
const DevMock = import.meta.env.DEV
  ? lazy(() => import("./app/devRoutes").then((m) => ({ default: m.DevMock })))
  : null
import { ActivityScreen } from "./ui/screens/ActivityScreen/ActivityScreen"
import { HomeScreen } from "./ui/screens/HomeScreen/HomeScreen"
import { NotFoundScreen } from "./ui/screens/NotFoundScreen"
import { SettingsScreen } from "./ui/screens/SettingsScreen"
import { LeaveGuardMount } from "./features/operations/LeaveGuardMount"
import type { DeviceState } from "./platform/storage/deviceKeys"
import type { PageFacts } from "./session/pageChain"

/** What the active tab hands the app once it may run the wallet. */
export interface ActiveTabBoot {
  /** The one node client, handed to everything that needs one. */
  node: AztecNode
  pxeBoot: PxeBootTarget
}

/**
 * Everything the provider tree needs, created on the App's first render (not
 * at module import) so a config error renders through the error boundary in
 * `main.tsx` instead of white-screening. References stay stable for the app's
 * lifetime.
 */
function createAppServices(
  node: AztecNode,
  device: ReadonlyStore<DeviceState>,
  { config, chain }: PageFacts,
) {
  TokenService.setImmutablesSource((token) => chain.tokenImmutablesOf(token.toString()).read())
  // Bound before first render so even pre-route events (PXE boot) are consent-gated.
  bindAnalyticsConsent(() => device.get().analyticsConsent)
  wireTxTimingAnalytics()
  setPerfLogFlag(proveTxPerfLogsEnabled)
  return { config, node }
}

/** The PXE and the contract service are up. Demo mode never boots a PXE, so it has no service. */
function useBootReady(): boolean {
  const session = useSession()
  const { bootStatus } = usePxeBoot(session.page)
  const contractService = useStore(session.contractService, serviceStatus)
  return bootStatus === "ready" && (contractService === "ready" || isDemoMode())
}

/** Holds a surface until the PXE and the contract service are up, starting a boot that waits. */
export function BootHold() {
  const { page } = useSession()
  const { bootStatus, bootError, retryBoot, startBoot } = usePxeBoot(page)
  const ready = useBootReady()
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(startBoot, [startBoot])
  if (bootStatus === "error")
    return <BootErrorScreen error={bootError} onRetry={retryBoot} walletOpen config={page.config} />
  if (!ready) return <BootSplash />
  return <Outlet />
}

/**
 * Starts the session's token and TEE signer under the wallet and paylink surfaces that need them.
 * Onboarding stays out on purpose: the token's PXE work alongside the sponsored account-setup tx
 * starves the single-threaded browser PXE, which hangs onboarding on slower machines. A signup a
 * payment link funds is the exception: its claim needs them, so the link page and ClaimRoute start
 * them too.
 *
 * They wait for the boot: before the contract service exists the TEE signer source has no oxide
 * client to load from.
 */
function AssetGate() {
  const ready = useBootReady()
  useStartAssets(ready)
  return <Outlet />
}

/**
 * Wallet routes require an entered identity (a name is NOT required — nameless accounts are
 * prompted to register from Home). It reads loaded stores, so this sits above BootHold: a visitor
 * without one is routed without waiting on the PXE. A tag drawn for this tab's signup lets the
 * visitor in to Home, which hosts the signup until the passkey exists. A visitor a retired
 * rollup's session names goes to /enter, which signs it in from that session's key.
 */
export function WalletEntryGate() {
  const ready = useBootReady()
  const session = useSession()
  const draft = useStore(session.signup.state, (s) => s.drawnOffer)
  const device = useStore(session.device)
  const entered = enteredIdentity(
    useStore(session.identity),
    device.passkeyMap,
    session.page.config.rpId,
  )
  const leaving = useStore(session.leaving)
  if (entered === null && !draft && !leaving)
    return (
      <>
        <Navigate to={session.auth.retiredSession() ? "/enter" : "/claim"} replace />
        {/* The redirect is no first screen: the boot screen holds until /claim's own wait. */}
        {!ready && <BootSplash />}
      </>
    )
  return <Outlet />
}

/** Home before any passkey: the drawn tag waits for keep-or-choose, and the signup runs from it. */
function DraftHome({ tag }: { tag: string }) {
  const location = useLocation()
  if (location.pathname !== "/") return <Navigate to="/" replace />
  return <OnboardingScreen embedded draftTag={tag} />
}

function WalletGate() {
  const location = useLocation()
  const claimPending = useNameClaimPending()
  const session = useSession()
  const draft = useStore(session.signup.state, (s) => s.drawnOffer)
  const { passkeyMap } = useStore(session.device)
  const entered = enteredIdentity(useStore(session.identity), passkeyMap, session.page.config.rpId)
  if (entered === null && draft) return <DraftHome tag={draft} />
  // A stashed inbound connect replays once the gates pass — e.g. after onboarding routed
  // away from /connect. The stash is consume-once, so this fires at most one redirect. While the
  // name claim is pending, /connect goes back to Home, so the replay waits for the claim.
  if (!claimPending && location.pathname !== "/connect" && hasConnectStash(tabStash)) {
    return <Navigate to="/connect" replace />
  }
  return (
    <UnlockGate>
      {/* Unlocked only: the lock/visibility-scoped XMTP client + stage-2 inbox. Demo mode has no
          network identity to register, so it renders the seeded stores as-is. */}
      {!isDemoMode() && <XmtpMount />}
      {/* Not behind the backup flag: a saved rotation keeps moving with the flag off. */}
      {!isDemoMode() && <BackupRotationMount />}
      <Outlet />
      {/* Last so the upgrade dialog stacks above route-level sheets. */}
      <MigrationDetectionMount />
    </UnlockGate>
  )
}

/** Until the tag is claimed on L1 these routes go to Home, which shows the activation progress. */
function ClaimPendingGate() {
  if (useNameClaimPending()) return <Navigate to="/" replace />
  return <Outlet />
}

/**
 * A route that starts `action`, gated by {@link actionVerdict} on the attempt, with the reason:
 * a nameless account is asked for a name, one whose registration has yet to reach the rollup waits
 * for it, and one that must upgrade goes to Home with the upgrade sheet titled for the action.
 * A sponsored action waits while a backup passkey rotation moves the balance, and a new link while
 * a backup passkey add has yet to switch the account. A registered account spends a few seconds
 * checking on every cold load, so that reads as loading.
 */
export function ActionGate({ action }: { action: WalletAction }) {
  const verdict = useActionVerdict(action)
  const { pace } = useSession().page
  switch (verdict) {
    case "open":
      return <Outlet />
    case "holding":
    case "checking":
      return <BootSplash inShell />
    case "upgrade":
      return <UpgradeFirst action={action} to="/" />
    case "refund":
      return <OldVersionWithdrawScreen pace={pace} />
    case "home":
      return <Navigate to="/" replace />
    case "moving":
      return <BalanceMovingScreen />
    case "backup":
      return <LinkWaitsScreen />
    default:
      return <NameRequiredScreen pending={verdict === "registering"} />
  }
}

/** Leaves an action's route for `to`, asking for the upgrade first. */
function UpgradeFirst({ action, to }: { action: WalletAction; to: string }) {
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => openMigrationDialog({ action }), [action])
  return <Navigate to={to} replace />
}

/**
 * A contact's page with its Send flow as a child route, so opening Send keeps the page mounted.
 * Send is gated like the action routes, except that the check never holds the modal: the flow
 * keeps Confirm disabled until it answers. An upgrade to make leaves Send for the contact's page.
 */
export function ContactRoute() {
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from
  const verdict = useActionVerdict("send")
  const pay = useOutlet()
  if (pay && verdict === "upgrade")
    return <UpgradeFirst action="send" to={location.pathname.replace(/\/send\/?$/, "")} />
  if (pay && (verdict === "registering" || verdict === "name")) {
    return <NameRequiredScreen pending={verdict === "registering"} />
  }
  if (pay && verdict === "moving") return <BalanceMovingScreen />
  return (
    <>
      {pay && from !== "detail" ? <SendScreen /> : <ContactDetailScreen />}
      {pay}
    </>
  )
}

/** The wallet's router, opening on any route the pre-boot screen went to. */
function AppRouter({ preBoot, children }: { preBoot: PreBoot; children: ReactNode }) {
  useState(() => preBoot.applyNavigation())
  return (
    <BrowserRouter>
      <PreBootRouterBridge preBoot={preBoot} />
      {children}
    </BrowserRouter>
  )
}

const failure = (state: ServiceState<unknown>) =>
  state.status === "failed" ? state.error : undefined

export function App({ boot, activeTab }: { boot: PageBoot; activeTab: ActiveTabBoot }) {
  const { contractService, device, page } = useSession()
  const [services] = useState(() => createAppServices(activeTab.node, device, page))
  // Stash an inbound /connect packet before any gate redirect can drop the fragment.
  useState(stashInboundConnect)
  const serviceFailure = useStore(contractService, failure)
  const gateFailure = useStore(page.manifestGate, failure)
  // The error boundary renders a failed service, or a mainnet manifest the client refused.
  if (serviceFailure) throw serviceFailure
  if (gateFailure) throw gateFailure
  return (
    // No reconnect on load: a session reads no wallet until the user connects.
    <WagmiProvider config={boot.page.wagmi} reconnectOnMount={false}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={rainbowkitTheme} modalSize="compact">
          <RainbowKitModalLayer>
            <LeaveGuardMount />
            {ProfilePanel && (
              <Suspense fallback={null}>
                <ProfilePanel />
              </Suspense>
            )}
            <PxeBootProvider pxeBoot={activeTab.pxeBoot} page={page}>
              <AppRouter preBoot={boot.page.preBoot}>
                <BootStarter wantWallet={page.wantWallet} />
                {/* L1 address screening (withdraw recipient, deposit EOA, registration payer) on every route. */}
                <ScanNavigationProvider>
                  <ScreeningProvider screenings={page.screening}>
                    <Routes>
                      <Route
                        element={
                          <AppShell
                            notice={
                              boot.bootedFromBakedProfile && boot.bakedProfile ? (
                                <BakedProfileNotice
                                  publishedAt={boot.bakedProfile.publishedAt}
                                  forced={boot.bakedProfile.forced}
                                  expired={boot.bakedProfile.expired}
                                  settingsPath={getDesktopSettingsPath() ?? undefined}
                                />
                              ) : boot.customProfileUrl ? (
                                <CustomProfileNotice
                                  url={boot.customProfileUrl}
                                  settingsPath={getDesktopSettingsPath() ?? undefined}
                                />
                              ) : undefined
                            }
                          />
                        }
                      >
                        {/* The pay page, and the older request-link entry. The SIPA pay-QR paints
                      before the PXE is up; the accountless right pane nests the /claim wizard. */}
                        {["pay/:tag", "request", "r"].map((path) => (
                          <Route
                            key={path}
                            path={path}
                            element={
                              <RequestLandingScreen
                                node={services.node}
                                chainIdentity={
                                  activeTab.pxeBoot.kind === "pxe"
                                    ? activeTab.pxeBoot.identity
                                    : undefined
                                }
                              />
                            }
                          >
                            <Route element={<BootHold />}>
                              <Route index element={<OnboardingScreen embedded />} />
                            </Route>
                          </Route>
                        ))}
                        {DevMock && (
                          <Route
                            path="dev/mock/pay/:name?"
                            element={
                              <Suspense fallback={null}>
                                <DevMock
                                  area="pay"
                                  node={services.node}
                                  chainIdentity={
                                    activeTab.pxeBoot.kind === "pxe"
                                      ? activeTab.pxeBoot.identity
                                      : undefined
                                  }
                                />
                              </Suspense>
                            }
                          />
                        )}
                        {/* BootHold PXE-gates each surface. */}
                        <Route>
                          {/* Onboarding starts no token, except the resume of a registration a
                        payment link funds (ClaimRoute). The signup wizard is
                        full-bleed (it carries its own invitation chrome). */}
                          <Route element={<BootHold />}>
                            <Route path="claim/:handle?" element={<ClaimRoute />} />
                            <Route path="enter" element={<EnterAppScreen />} />
                          </Route>
                          {/* Wallet + paylink surfaces start the token and its co-signer. */}
                          <Route element={<AssetGate />}>
                            {/* Wallet surface: desktop sidebar shell; requires a claimed identity +
                          unlocked MSK (WalletGate renders the unlock pane inside the shell). */}
                            <Route element={<WalletEntryGate />}>
                              <Route element={<BootHold />}>
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
                                    <Route path="savings" element={<HomeScreen />} />
                                    <Route path="settings" element={<SettingsScreen />} />
                                    <Route path="activity" element={<ActivityScreen />} />
                                    <Route element={<ActionGate action="receive" />}>
                                      <Route path="receive" element={<ReceiveScreen />} />
                                    </Route>
                                    <Route element={<ClaimPendingGate />}>
                                      {/* A picker: each way out is gated on its own. */}
                                      <Route path="send" element={<SendScreen />} />
                                      <Route path="contacts" element={<ContactsScreen />} />
                                      <Route element={<ActionGate action="requests" />}>
                                        <Route path={REQUESTS_PATH} element={<RequestsScreen />} />
                                        <Route
                                          path={NON_CONTACT_REQUESTS_PATH}
                                          element={<NonContactRequestsScreen />}
                                        />
                                      </Route>
                                      <Route path="connect" element={<ConnectReceiveScreen />} />
                                      <Route path="contacts/:idOrTag" element={<ContactRoute />}>
                                        <Route
                                          path="send"
                                          element={<ContactPayScreen mode="send" />}
                                        />
                                      </Route>
                                    </Route>
                                    <Route element={<ActionGate action="deposit" />}>
                                      <Route
                                        path="deposit"
                                        element={<DepositScreen claimName={claimChosenName} />}
                                      />
                                      {DevMock && (
                                        <Route
                                          path="dev/mock/deposit/:name?"
                                          element={
                                            <Suspense fallback={null}>
                                              <DevMock area="deposit" node={services.node} />
                                            </Suspense>
                                          }
                                        />
                                      )}
                                    </Route>
                                    <Route element={<ActionGate action="link" />}>
                                      <Route path="links/new" element={<NewLinkScreen />} />
                                    </Route>
                                    <Route element={<ActionGate action="withdraw" />}>
                                      <Route path="withdraw" element={<WithdrawMethodScreen />}>
                                        <Route index element={null} />
                                        <Route path="fresh" element={null} />
                                        <Route path="bridge" element={null} />
                                        <Route path="etherfi" element={null} />
                                      </Route>
                                      {DevMock && (
                                        <Route
                                          path="dev/mock/withdraw/:name?"
                                          element={
                                            <Suspense fallback={null}>
                                              <DevMock area="withdraw" node={services.node} />
                                            </Suspense>
                                          }
                                        />
                                      )}
                                    </Route>
                                  </Route>
                                </Route>
                              </Route>
                            </Route>
                            {/* Link view is identity-free but needs the token or co-signer to claim. */}
                            <Route element={<BootHold />}>
                              <Route path="link" element={<LinkViewScreen />} />
                              {/* The zk.money apex's short paylink path. */}
                              <Route path="p" element={<LinkViewScreen />} />
                            </Route>
                          </Route>
                        </Route>
                        {/* Unknown routes: branded 404 outside the PXE gate — no boot splash for a dead URL. */}
                        <Route path="*" element={<NotFoundScreen />} />
                      </Route>
                    </Routes>
                  </ScreeningProvider>
                </ScanNavigationProvider>
              </AppRouter>
              {/* Global error/info modal — any catch block surfaces it via showErrorModal(). */}
              <ErrorModalHost network={page.config.network} />
            </PxeBootProvider>
          </RainbowKitModalLayer>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
