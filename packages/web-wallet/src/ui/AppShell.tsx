import { GradientInitialAvatar, Icon, ZkMoneyRoot } from "@obsidion/web-ds"
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { Outlet, useLocation, useNavigate } from "react-router-dom"
import { AnalyticsConsentPrompt } from "../features/onboarding/AnalyticsConsentModal"
import { useRegistrationDepositOwed } from "../features/onboarding/openRegistration"
import { useActionGuard, type WalletAction } from "../features/actionGate"
import { useTagUnpicked } from "../features/onboarding/tagPick"
import { TagSearchBar } from "../features/contacts/TagSearchBar"
import { loadOnboardedIdentity, loadWalletIdentity } from "../features/identity/walletIdentity"
import { logout } from "../features/identity/logout"
import { isLogoutBlockedByRegistration } from "../features/onboarding/webRegistration"
import { getAuthService } from "../platform/auth/useAuthenticator"
import { openedSession } from "../platform/session"
import { getDesktopL1Bridge } from "../platform/desktopBridge"
import { ScannerModal } from "../features/scan/ScannerModal"
import { scanPayload } from "../features/scan/scanPayload"
import { useScanNavigation } from "../features/scan/ScanNavigation"
import { useScanShare } from "../features/scan/useScanShare"
import { BrandLockup } from "./BrandLockup"
import { BootSplash } from "./PxeBoot"
import { LogoutBlockedModal } from "./LogoutBlockedModal"
import { LogoutModal } from "./LogoutModal"
import { MobileMenu } from "./MobileMenu"
import { PhoneIcon, type PhoneIconName } from "./PhoneIcon"
import { usePhoneLayout } from "./usePhoneLayout"
import { useNotificationsPanelOpen } from "./NotificationsPanel"
import { NotificationsBell } from "./NotificationsBell"
import {
  ContactStorage,
  nameL1ContactsByEns,
  useAccountContext,
  useAztecContext,
  useStore,
} from "@obsidion/front-core"
import { ensClient } from "../lib/ens"
import { isDemoMode } from "../dev/demoFlag"
import { REQUESTS_PATH } from "../features/requests/nonContactView"
import { useSavingsAvailable } from "../features/savings/savingsGateway"
import { UpgradeKeepOpenBanner } from "../features/migration/UpgradeIntro"
import { createContext, useContext, useMemo } from "react"
import "./shell.css"

/**
 * Root frame: dark canvas at full viewport width. Layout comes from the nested layouts below.
 * `notice` is a persistent strip every route shares (inside the design-system root, so it is
 * styled like the rest of the wallet).
 */
export function AppShell({ notice }: { notice?: ReactNode }) {
  // Every route reads the session, which boot opens before the first render.
  const open = useStore(openedSession) !== null
  return (
    <ShellRoot>
      {notice}
      {open ? <Outlet /> : <BootSplash />}
    </ShellRoot>
  )
}

export function ShellRoot({ children }: { children: ReactNode }) {
  return (
    <ZkMoneyRoot flush style={{ minHeight: "100dvh" }}>
      {children}
    </ZkMoneyRoot>
  )
}

type NavItem = { label: string; icon: PhoneIconName; path: string }

const NAV_MAIN: NavItem[] = [
  { label: "Home", icon: "home", path: "/" },
  { label: "Savings", icon: "earn", path: "/savings" },
  { label: "Deposit", icon: "coins", path: "/deposit" },
  { label: "Send", icon: "send", path: "/send" },
  { label: "Requests", icon: "payments-arrows", path: REQUESTS_PATH },
  { label: "Withdraw", icon: "tray-withdraw", path: "/withdraw" },
  { label: "Activity", icon: "history-clock", path: "/activity" },
]
const NAV_PHONE: NavItem[] = [
  { label: "Home", icon: "home", path: "/" },
  { label: "Savings", icon: "earn", path: "/savings" },
  { label: "Deposit", icon: "coins", path: "/deposit" },
  { label: "Requests", icon: "payments-arrows", path: REQUESTS_PATH },
  { label: "Send", icon: "send", path: "/send" },
  { label: "Withdraw", icon: "tray-withdraw", path: "/withdraw" },
  { label: "Activity", icon: "history-clock", path: "/activity" },
]
const NAV_SETTINGS: NavItem = { label: "Settings", icon: "settings", path: "/settings" }
/** Phone tab bar: Home and the four payment actions, in the menu's order. */
const NAV_TABS: NavItem[] = NAV_PHONE.filter(
  ({ path }) => path !== "/activity" && path !== "/savings",
)
/** Savings shows only once its deployment is known. */
const navItems = (items: NavItem[], savings: boolean) =>
  items.filter((item) => item.path !== "/savings" || savings)
/** Routes that move money: with a name still waiting for its deposit they lead to Deposit. */
const ACTIVATION_GATED = new Set(["/deposit", "/send", REQUESTS_PATH, "/withdraw"])
/** Nav items that start an action. */
const NAV_ACTIONS: Record<string, WalletAction> = {
  "/deposit": "deposit",
  "/send": "send",
  [REQUESTS_PATH]: "requests",
  "/withdraw": "withdraw",
}

function activePath(pathname: string): string {
  // Receive and Contacts have no nav item: Requests is the way in.
  if (
    pathname.startsWith("/receive") ||
    pathname.startsWith("/contacts") ||
    pathname.startsWith("/connect") ||
    pathname.startsWith(REQUESTS_PATH)
  ) {
    return REQUESTS_PATH
  }
  for (const p of [
    "/savings",
    "/activity",
    "/settings",
    "/deposit",
    "/withdraw",
    "/send",
    "/links",
  ]) {
    if (pathname.startsWith(p)) return p
  }
  return "/"
}

type ShellAction = (event?: { currentTarget: HTMLElement }) => void
type ShellActions = {
  openMenu: ShellAction
  openReceive: ShellAction
  openScanner: ShellAction
  scannerAvailable: boolean
}
const ShellActionsContext = createContext<ShellActions | null>(null)

/** Page headers use the same menu, Receive and Scan entry points as the shell. */
export function useShellActions(): ShellActions {
  const actions = useContext(ShellActionsContext)
  if (!actions) throw new Error("Shell actions require SidebarLayout")
  return actions
}

/** Wallet navigation and the responsive header around guarded routes. */
export function SidebarLayout({
  mobilePageHeaderPaths = [],
  enablePhoneScan = false,
}: {
  mobilePageHeaderPaths?: readonly string[]
  enablePhoneScan?: boolean
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const identity = loadWalletIdentity()
  const awaitingActivation = useRegistrationDepositOwed()
  const guard = useActionGuard()
  // An unpicked drawn tag is never shown: no account button and no share.
  const unpicked = useTagUnpicked()
  const active = activePath(location.pathname)
  const [open, setOpen] = useState(false)
  const phone = usePhoneLayout()
  const [notificationsOpen, setNotificationsOpen] = useNotificationsPanelOpen()
  const [logoutPrompt, setLogoutPrompt] = useState<null | "confirm" | "blocked">(null)
  const main = useRef<HTMLElement>(null)
  const menuOpener = useRef<HTMLElement | null>(null)
  const handoff = useScanNavigation()
  const { obsidionWallet } = useAztecContext()
  const finishLogout = useCallback(
    () => logout(() => obsidionWallet?.pxe.stop() ?? Promise.resolve()),
    [obsidionWallet],
  )
  // Same unlock condition as UnlockGate: the bell must not surface stored notifications
  // above the locked pane.
  const unlocked = !!useAccountContext().obsidionAccount || isDemoMode()
  const savings = useSavingsAvailable()
  const pageHeader = phone && unlocked && mobilePageHeaderPaths.includes(location.pathname)
  const scannerAvailable =
    enablePhoneScan &&
    phone &&
    unlocked &&
    !!identity?.handle &&
    !identity.pending &&
    !!loadOnboardedIdentity() &&
    getDesktopL1Bridge() === null
  const scanShare = useScanShare({
    routeKey: location.key,
    identityKey: identity?.address,
    scanAvailable: scannerAvailable,
    fallback: () => {
      const target = main.current
      if (target) target.tabIndex = -1
      return target
    },
    resolve: async (payload) => {
      const currentIdentity = loadOnboardedIdentity()
      if (
        !currentIdentity?.handle ||
        currentIdentity.pending ||
        currentIdentity.address !== identity?.address ||
        currentIdentity.handle !== identity.handle ||
        !(await getAuthService().getSecretKey())
      ) {
        return { kind: "error", message: "Unlock your registered wallet to scan a code." }
      }
      return scanPayload(payload, {
        ownTag: currentIdentity.handle,
        ownL2Address: currentIdentity.address,
        contacts: await ContactStorage.get().getEntries(),
      })
    },
    onDestination: handoff,
  })
  const captureOpener = (source?: HTMLElement) => {
    const focused =
      source ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    return focused?.closest("#wallet-menu") ? menuOpener.current : focused
  }

  const openMenu = useCallback<ShellAction>(
    (event) => {
      menuOpener.current =
        event?.currentTarget ??
        (document.activeElement instanceof HTMLElement ? document.activeElement : null)
      setNotificationsOpen(false)
      setOpen(true)
    },
    [setNotificationsOpen],
  )
  const openReceive = useCallback<ShellAction>(() => {
    setOpen(false)
    setNotificationsOpen(false)
    if (awaitingActivation) navigate("/deposit")
    // Locked, nothing can tell yet whether the upgrade comes first: the route asks once unlocked.
    else if (!unlocked) navigate("/receive")
    else guard("receive", () => navigate("/receive"))
  }, [awaitingActivation, navigate, setNotificationsOpen, guard, unlocked])
  const openScanner = useCallback<ShellAction>(
    (event) => {
      if (!scannerAvailable) return
      const opener = captureOpener(event?.currentTarget)
      setOpen(false)
      setNotificationsOpen(false)
      scanShare.open("scan", opener)
    },
    [scannerAvailable, setNotificationsOpen, scanShare.open],
  )
  const shellActions = useMemo(
    () => ({ openMenu, openReceive, openScanner, scannerAvailable }),
    [openMenu, openReceive, openScanner, scannerAvailable],
  )

  useEffect(() => {
    setOpen(false)
  }, [location.key, phone])
  useEffect(() => {
    if (notificationsOpen) setOpen(false)
  }, [notificationsOpen])
  useEffect(() => nameL1ContactsByEns(ensClient), [])
  // The phone header sticks once the page scrolls past its top padding.
  const [stuck, setStuck] = useState(false)
  useEffect(() => {
    const scroller = main.current
    if (!phone || !scroller) return
    const update = () => setStuck(scroller.scrollTop > 8)
    update()
    scroller.addEventListener("scroll", update, { passive: true })
    return () => scroller.removeEventListener("scroll", update)
  }, [phone])

  const go = (item: NavItem) => {
    setOpen(false)
    if (awaitingActivation && ACTIVATION_GATED.has(item.path)) return navigate("/deposit")
    const action = NAV_ACTIONS[item.path]
    if (action && unlocked) guard(action, () => navigate(item.path))
    else navigate(item.path)
  }

  const navButton = (item: NavItem) => (
    <button
      key={item.label}
      type="button"
      className={["zkm-btn-reset ww-nav-item", active === item.path ? "ww-nav-item--active" : ""]
        .filter(Boolean)
        .join(" ")}
      aria-current={active === item.path ? "page" : undefined}
      onClick={() => go(item)}
    >
      {phone ? <PhoneIcon name={item.icon} /> : <Icon name={item.icon} size={24} />}
      <span>{item.label}</span>
    </button>
  )

  const identityLabel = identity
    ? identity.handle
      ? `@${identity.handle}.zk.money`
      : `${identity.address.slice(0, 8)}… no name yet`
    : ""
  const identityMeta = identity && (
    <span className="ww-account__meta">
      {identity.handle ? (
        <>
          <span>@{identity.handle}</span>
          <span>.zk.money</span>
        </>
      ) : (
        <>
          <span>{`${identity.address.slice(0, 8)}…`}</span>
          <span>no name yet</span>
        </>
      )}
    </span>
  )

  // Phone menu head: the identity pill carries Receive and the one-tap way home.
  const drawerAccount = phone && unlocked && identity && !unpicked && (
    <div className="ww-sidebar__account">
      <button
        type="button"
        className="zkm-btn-reset zkm-pressable ww-iconbtn ww-iconbtn--brand"
        aria-label="Receive code"
        onClick={openReceive}
      >
        <PhoneIcon name="qr-code" color="#fff" />
      </button>
      <button
        type="button"
        className="zkm-btn-reset ww-sidebar__identity"
        aria-label={`Home, ${identityLabel}`}
        onClick={() => go(NAV_PHONE[0])}
      >
        {identityMeta}
      </button>
    </div>
  )

  const navigation = (
    <nav
      className={phone ? "ww-sidebar ww-sidebar--open" : "ww-sidebar"}
      aria-label="Primary navigation"
    >
      <div className="ww-sidebar__head">
        {drawerAccount || <BrandLockup />}
        <div className="ww-sidebar__head-actions">
          {!drawerAccount && !unpicked && (
            <button
              type="button"
              className="zkm-btn-reset zkm-pressable ww-iconbtn ww-iconbtn--brand"
              aria-label="Receive code"
              onClick={openReceive}
            >
              {phone ? (
                <PhoneIcon name="qr-code" color="#fff" />
              ) : (
                <Icon name="qr-code" size={24} color="#fff" />
              )}
            </button>
          )}
          <button
            type="button"
            className={
              phone
                ? "zkm-btn-reset zkm-pressable ww-iconbtn ww-iconbtn--lg"
                : "zkm-btn-reset zkm-pressable ww-iconbtn"
            }
            aria-label="Close menu"
            onClick={() => setOpen(false)}
          >
            {phone ? <PhoneIcon name="x" size={32} color="#fff" /> : <Icon name="x" size={24} />}
          </button>
        </div>
      </div>
      <hr className="ww-divider" />
      <div className="ww-sidebar__menu">
        {navItems(phone ? NAV_PHONE : NAV_MAIN, savings).map(navButton)}
        <hr className="ww-divider" />
        {navButton(NAV_SETTINGS)}
      </div>
      <button
        type="button"
        className="zkm-btn-reset ww-nav-item"
        onClick={() => {
          setOpen(false)
          setNotificationsOpen(false)
          setLogoutPrompt(unlocked && isLogoutBlockedByRegistration() ? "blocked" : "confirm")
        }}
      >
        {phone ? <PhoneIcon name="logout" /> : <Icon name="logout" size={24} />}
        <span>Log out</span>
      </button>
    </nav>
  )

  const account = !unpicked && identity && !phone && (
    <button
      type="button"
      className="zkm-btn-reset ww-account"
      aria-label={`Account settings, ${identityLabel}`}
      onClick={() => navigate("/settings")}
    >
      <GradientInitialAvatar name={identity.handle ?? identity.address} size={40} ringed />
      {identityMeta}
    </button>
  )

  const tabBar = phone && unlocked && !pageHeader && (
    <nav className="ww-tabbar" aria-label="Quick navigation">
      {NAV_TABS.map((item) => (
        <button
          key={item.label}
          type="button"
          className={[
            "zkm-btn-reset ww-tabbar__item",
            active === item.path ? "ww-tabbar__item--active" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-current={active === item.path ? "page" : undefined}
          onClick={() => go(item)}
        >
          <PhoneIcon name={item.icon} />
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  )

  return (
    <ShellActionsContext.Provider value={shellActions}>
      <div
        className={[
          "ww-shell",
          phone && location.pathname === "/" ? "ww-shell--home" : "",
          tabBar ? "ww-shell--tabbar" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div className="ww-shell__glow" aria-hidden />
        {phone ? (
          <MobileMenu open={open} onClose={() => setOpen(false)}>
            {navigation}
          </MobileMenu>
        ) : (
          navigation
        )}
        <main ref={main} className="ww-main">
          <div className="ww-content">
            {!pageHeader && (
              <div
                className="ww-shell-header"
                data-stuck={(phone && stuck && !notificationsOpen) || undefined}
              >
                <div className="ww-topbar">
                  {(!phone || unlocked) && <TagSearchBar placeholder={phone ? "tag" : undefined} />}
                  {phone && !unlocked && <BrandLockup />}
                  <div className="ww-topbar__actions">
                    {unlocked && <NotificationsBell />}
                    {!phone && !unpicked && (
                      <button
                        type="button"
                        className="zkm-btn-reset zkm-pressable ww-iconbtn ww-iconbtn--lg"
                        aria-label="Receive code"
                        onClick={openReceive}
                      >
                        <Icon name="qr-code" size={24} />
                      </button>
                    )}
                    {!phone && account}
                    {phone && (
                      <button
                        type="button"
                        className="zkm-btn-reset zkm-pressable ww-iconbtn ww-iconbtn--lg ww-iconbtn--menu"
                        aria-label="Open menu"
                        aria-haspopup="dialog"
                        aria-expanded={open}
                        aria-controls={open ? "wallet-menu" : undefined}
                        onClick={openMenu}
                      >
                        <PhoneIcon name="menu" size={30} color="#fff" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
            <UpgradeKeepOpenBanner />
            <Outlet />
          </div>
        </main>
        {tabBar}
        {unlocked && <AnalyticsConsentPrompt />}
        {logoutPrompt === "blocked" && (
          <LogoutBlockedModal onClose={() => setLogoutPrompt(null)} onConfirm={finishLogout} />
        )}
        {logoutPrompt === "confirm" && (
          <LogoutModal onClose={() => setLogoutPrompt(null)} onConfirm={finishLogout} />
        )}
        {scanShare.session?.surface === "scan" && (
          <ScannerModal
            key={scanShare.session.id}
            onClose={() => scanShare.close(scanShare.session!.id)}
            onShare={() => {
              scanShare.close(scanShare.session!.id)
              openReceive()
            }}
            resolvePayload={(payload) => scanShare.resolve(scanShare.session!.id, payload)}
            onDestination={(destination) =>
              scanShare.destination(scanShare.session!.id, destination)
            }
          />
        )}
      </div>
    </ShellActionsContext.Provider>
  )
}
