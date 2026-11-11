import { GradientInitialAvatar, Icon, ZkMoneyRoot, type IconName } from "@obsidion/web-ds"
import { useCallback, useRef, useState, type ReactNode } from "react"
import { Outlet, useLocation, useNavigate } from "react-router-dom"
import { AnalyticsConsentPrompt } from "../../features/onboarding/AnalyticsConsentModal/AnalyticsConsentModal"
import { useRegistrationDepositOwed } from "../../features/registration/openRegistration"
import { useActionGuard, type WalletAction } from "../../features/actionGate"
import { useTagUnpicked } from "../../features/onboarding/useTagUnpicked"
import { TagSearchBar } from "../../features/contacts/TagSearchBar"
import { enteredIdentity } from "../../session/account"
import { LogoutPrompt, type LogoutKind } from "../../features/identity/LogoutPrompt/LogoutPrompt"
import {
  isLogoutBlockedByRegistration,
  isTagPresentationPending,
  useTagPresentationPending,
} from "../../features/registration/webRegistration"
import { openedSession, useSession } from "../../session/session"
import { getDesktopL1Bridge } from "../../platform/desktopBridge"
import { nextTheme, type Theme } from "../../platform/storage/theme"
import { ScannerModal } from "../../features/scan/ScannerModal"
import { scanPayload } from "../../features/scan/scanPayload"
import { useScanNavigation } from "../../features/scan/ScanNavigation"
import { useScanShare } from "../../features/scan/useScanShare"
import { BrandLockup } from "../BrandLockup"
import { BootSplash } from "../PxeBoot"
import { MobileMenu } from "../MobileMenu"
import { PhoneIcon, type PhoneIconName } from "../PhoneIcon"
import { usePhoneLayout } from "../usePhoneLayout"
import { useNotificationsPanelOpen } from "../NotificationsPanel/NotificationsPanel"
import { NotificationsBell } from "../NotificationsBell/NotificationsBell"
import { NO_SERVICE, serviceStatus, useStore, WalletError } from "@obsidion/front-core"
import { isDemoMode } from "../../dev/demoFlag"
import { REQUESTS_PATH } from "../../features/requests/nonContactView"
import { useSavingsAvailable } from "../../features/savings/savingsGateway"
import { UpgradeKeepOpenBanner } from "../../features/migration/UpgradeIntro"
import { BackupNudgeBadge } from "../../features/backupPasskey/BackupNudge/BackupNudge"
import { createContext, useContext, useMemo } from "react"
import "../shell.css"
import styles from "./AppShell.module.css"
import copy from "./AppShell.copy"
import { fmt } from "../../lib/fmt"
import { useDomEffect } from "../useDomEffect"

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

/** The theme control shows the theme it switches to. */
const THEME_ICONS: Record<Theme, IconName> = { dark: "moon", light: "sun" }

const NAV_MAIN: NavItem[] = [
  { label: copy.nav.home, icon: "home", path: "/" },
  { label: copy.nav.savings, icon: "earn", path: "/savings" },
  { label: copy.nav.deposit, icon: "coins", path: "/deposit" },
  { label: copy.nav.send, icon: "send", path: "/send" },
  { label: copy.nav.requests, icon: "payments-arrows", path: REQUESTS_PATH },
  { label: copy.nav.withdraw, icon: "tray-withdraw", path: "/withdraw" },
  { label: copy.nav.activity, icon: "history-clock", path: "/activity" },
]
const NAV_PHONE: NavItem[] = [
  { label: copy.nav.home, icon: "home", path: "/" },
  { label: copy.nav.savings, icon: "earn", path: "/savings" },
  { label: copy.nav.deposit, icon: "coins", path: "/deposit" },
  { label: copy.nav.requests, icon: "payments-arrows", path: REQUESTS_PATH },
  { label: copy.nav.send, icon: "send", path: "/send" },
  { label: copy.nav.withdraw, icon: "tray-withdraw", path: "/withdraw" },
  { label: copy.nav.activity, icon: "history-clock", path: "/activity" },
]
const NAV_SETTINGS: NavItem = { label: copy.nav.settings, icon: "settings", path: "/settings" }
/** Phone tab bar: Home and the four payment actions, in the menu's order. */
const NAV_TABS: NavItem[] = NAV_PHONE.filter(
  ({ path }) => path !== "/activity" && path !== "/savings",
)
/** Savings shows only once its deployment is known. */
const navItems = (items: NavItem[], savings: boolean) =>
  items.filter((item) => item.path !== "/savings" || savings)
/** Routes that move money: with a name still waiting for its deposit they lead to Deposit. */
// eslint-disable-next-line no-restricted-syntax -- ZKM-1778
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
  if (!actions) throw new WalletError("invariant", "Shell actions require SidebarLayout")
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
  const session = useSession()
  const theme = useStore(session.page.theme.current)
  const identityView = useStore(session.identity)
  const identity = identityView.value
  const { passkeyMap } = useStore(session.device)
  const tagPending = useTagPresentationPending()
  const awaitingActivation = useRegistrationDepositOwed()
  const guard = useActionGuard()
  // An unpicked drawn tag is never shown: no account button and no share.
  const unpicked = useTagUnpicked()
  const active = activePath(location.pathname)
  const [open, setOpen] = useState(false)
  const phone = usePhoneLayout()
  const [notificationsOpen, setNotificationsOpen] = useNotificationsPanelOpen()
  const [logoutPrompt, setLogoutPrompt] = useState<LogoutKind | null>(null)
  const main = useRef<HTMLElement>(null)
  const menuOpener = useRef<HTMLElement | null>(null)
  const handoff = useScanNavigation()
  // Same unlock condition as UnlockGate: the bell must not surface stored notifications
  // above the locked pane.
  const unlocked =
    useStore(session.account ?? NO_SERVICE, serviceStatus) === "ready" || isDemoMode()
  // eslint-disable-next-line local/page-singleton -- ZKM-1778
  const savings = useSavingsAvailable()
  const pageHeader = phone && unlocked && mobilePageHeaderPaths.includes(location.pathname)
  const scannerAvailable =
    enablePhoneScan &&
    phone &&
    unlocked &&
    !!identity?.handle &&
    !tagPending &&
    !!enteredIdentity(identityView, passkeyMap, session.page.config.rpId) &&
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
      const currentIdentity = enteredIdentity(
        session.identity.get(),
        session.device.get().passkeyMap,
        session.page.config.rpId,
      )
      if (
        !currentIdentity?.handle ||
        isTagPresentationPending(session.registrations, currentIdentity) ||
        currentIdentity.address !== identity?.address ||
        currentIdentity.handle !== identity.handle ||
        !(await session.auth.getSecretKey())
      ) {
        return { kind: "error", message: copy.scanLocked }
      }
      return scanPayload(payload, {
        ownTag: currentIdentity.handle,
        ownL2Address: currentIdentity.address,
        contacts: session.contacts ? await session.contacts.all() : [],
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
  const openScanShare = scanShare.open
  const openScanner = useCallback<ShellAction>(
    (event) => {
      if (!scannerAvailable) return
      const opener = captureOpener(event?.currentTarget)
      setOpen(false)
      setNotificationsOpen(false)
      openScanShare("scan", opener)
    },
    [scannerAvailable, setNotificationsOpen, openScanShare],
  )
  const shellActions = useMemo(
    () => ({ openMenu, openReceive, openScanner, scannerAvailable }),
    [openMenu, openReceive, openScanner, scannerAvailable],
  )

  // A new route, a layout change or the notifications panel closes the menu.
  const shellKey = `${location.key}:${phone}`
  const [menuKey, setMenuKey] = useState(shellKey)
  if (menuKey !== shellKey) {
    setMenuKey(shellKey)
    setOpen(false)
  }
  if (open && notificationsOpen) setOpen(false)
  // The phone header sticks once the page scrolls past its top padding.
  const [stuck, setStuck] = useState(false)
  useDomEffect(() => {
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
      {item === NAV_SETTINGS && <BackupNudgeBadge className={styles.navBadge} />}
    </button>
  )

  const identityLabel = identity
    ? identity.handle
      ? fmt(copy.identity.tag, { handle: identity.handle })
      : fmt(copy.identity.unnamed, { address: identity.address.slice(0, 8) })
    : ""
  const identityMeta = identity && (
    <span className={styles.accountMeta}>
      {identity.handle ? (
        <>
          <span>@{identity.handle}</span>
          <span>{copy.identity.domain}</span>
        </>
      ) : (
        <>
          <span>{`${identity.address.slice(0, 8)}…`}</span>
          <span>{copy.identity.noName}</span>
        </>
      )}
    </span>
  )

  // Phone menu head: the identity pill carries Receive and the one-tap way home.
  const drawerAccount = phone && unlocked && identity && !unpicked && (
    <div className={styles.sidebarAccount}>
      <button
        type="button"
        className={`zkm-btn-reset zkm-pressable ww-iconbtn zkm-on-brand ${styles.iconbtnBrand}`}
        aria-label={copy.receiveCode}
        onClick={openReceive}
      >
        <PhoneIcon name="qr-code" color="#fff" />
      </button>
      <button
        type="button"
        className={`zkm-btn-reset ${styles.sidebarIdentity}`}
        aria-label={fmt(copy.home, { identity: identityLabel })}
        onClick={() => go(NAV_PHONE[0])}
      >
        {identityMeta}
      </button>
    </div>
  )

  // The phone keeps it in the menu's head, which leaves the top bar's search its width.
  const themeButton = (
    <button
      type="button"
      className="zkm-btn-reset zkm-pressable ww-iconbtn ww-iconbtn--lg"
      aria-label={copy.theme[nextTheme(theme)]}
      onClick={() => session.page.theme.set(nextTheme(theme))}
    >
      <Icon name={THEME_ICONS[nextTheme(theme)]} size={22} />
    </button>
  )

  const navigation = (
    <nav
      className={phone ? "ww-sidebar ww-sidebar--open" : "ww-sidebar"}
      aria-label={copy.primaryNav}
    >
      <div className={styles.sidebarHead}>
        {drawerAccount || <BrandLockup />}
        <div className={styles.sidebarHeadActions}>
          {phone && themeButton}
          {!drawerAccount && !unpicked && (
            <button
              type="button"
              className={`zkm-btn-reset zkm-pressable ww-iconbtn zkm-on-brand ${styles.iconbtnBrand}`}
              aria-label={copy.receiveCode}
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
            aria-label={copy.closeMenu}
            onClick={() => setOpen(false)}
          >
            {phone ? (
              <PhoneIcon name="x" size={32} color="var(--ink)" />
            ) : (
              <Icon name="x" size={24} />
            )}
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
          setLogoutPrompt(
            unlocked && isLogoutBlockedByRegistration(session) ? "blocked" : "confirm",
          )
        }}
      >
        {phone ? <PhoneIcon name="logout" /> : <Icon name="logout" size={24} />}
        <span>{copy.logOut}</span>
      </button>
    </nav>
  )

  const account = !unpicked && identity && !phone && (
    <button
      type="button"
      className={`zkm-btn-reset ${styles.account}`}
      aria-label={fmt(copy.accountSettings, { identity: identityLabel })}
      onClick={() => navigate("/settings")}
    >
      <GradientInitialAvatar name={identity.handle ?? identity.address} size={40} ringed />
      {identityMeta}
    </button>
  )

  const tabBar = phone && unlocked && !pageHeader && (
    <nav className="ww-tabbar" aria-label={copy.quickNav}>
      {NAV_TABS.map((item) => (
        <button
          key={item.label}
          type="button"
          className={[
            `zkm-btn-reset ${styles.tabbarItem}`,
            active === item.path ? styles.tabbarItemActive : "",
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
                  {(!phone || unlocked) && (
                    <TagSearchBar placeholder={phone ? copy.search : undefined} />
                  )}
                  {phone && !unlocked && <BrandLockup />}
                  <div className={styles.topbarActions}>
                    {!phone && themeButton}
                    {unlocked && <NotificationsBell />}
                    {!phone && !unpicked && (
                      <button
                        type="button"
                        className="zkm-btn-reset zkm-pressable ww-iconbtn ww-iconbtn--lg"
                        aria-label={copy.receiveCode}
                        onClick={openReceive}
                      >
                        <Icon name="qr-code" size={24} />
                      </button>
                    )}
                    {!phone && account}
                    {phone && (
                      <button
                        type="button"
                        className={`zkm-btn-reset zkm-pressable ww-iconbtn ww-iconbtn--lg ${styles.iconbtnMenu}`}
                        aria-label={copy.openMenu}
                        aria-haspopup="dialog"
                        aria-expanded={open}
                        aria-controls={open ? "wallet-menu" : undefined}
                        onClick={openMenu}
                      >
                        <PhoneIcon name="menu" size={30} color="var(--ink)" />
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
        {logoutPrompt && <LogoutPrompt kind={logoutPrompt} onClose={() => setLogoutPrompt(null)} />}
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
