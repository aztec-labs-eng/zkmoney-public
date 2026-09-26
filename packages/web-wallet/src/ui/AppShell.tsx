import { GradientInitialAvatar, Icon, Toast, ZkMoneyRoot } from "@obsidion/web-ds"
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { Outlet, useLocation, useNavigate } from "react-router-dom"
import { ShareTagModal } from "../features/contacts/ShareTagModal"
import {
  RegistrationDepositPrompt,
  useAwaitingDepositRecord,
} from "../features/onboarding/RegistrationDepositPrompt"
import { openActivationPrompt } from "../features/onboarding/activationPrompt"
import { TagSearchBar } from "../features/contacts/TagSearchBar"
import { loadOnboardedIdentity, loadWalletIdentity } from "../features/identity/walletIdentity"
import { logout } from "../features/identity/logout"
import { hasWalletEntry } from "../features/identity/admission"
import { isLogoutBlockedByRegistration } from "../features/onboarding/webRegistration"
import { getAuthService } from "../platform/auth/useAuthenticator"
import { getDesktopL1Bridge } from "../platform/desktopBridge"
import { ScannerModal } from "../features/scan/ScannerModal"
import { scanPayload } from "../features/scan/scanPayload"
import { useScanNavigation } from "../features/scan/ScanNavigation"
import { useScanShare } from "../features/scan/useScanShare"
import { BrandLockup } from "./BrandLockup"
import { LogoutBlockedModal } from "./LogoutBlockedModal"
import { LogoutModal } from "./LogoutModal"
import { MobileMenu } from "./MobileMenu"
import { PhoneIcon, type PhoneIconName } from "./PhoneIcon"
import { usePhoneLayout } from "./usePhoneLayout"
import {
  NotificationsPanel,
  freshToasts,
  notificationRoute,
  toastKey,
  useNotificationList,
  useNotificationsPanelOpen,
} from "./NotificationsPanel"
import { useOperationsInProgress, useTabBoundOperation } from "../features/operations/operations"
import {
  ContactStorage,
  useAccountContext,
  useAztecContext,
  type AppNotificationEntry,
} from "@obsidion/front-core"
import { isDemoMode } from "../dev/demoFlag"
import { createContext, useContext, useMemo } from "react"
import "./shell.css"

/**
 * Root frame: dark canvas at full viewport width. Layout comes from the nested layouts below.
 * `notice` is a persistent strip every route shares (inside the design-system root, so it is
 * styled like the rest of the wallet).
 */
export function AppShell({ notice }: { notice?: ReactNode }) {
  return (
    <ZkMoneyRoot flush style={{ minHeight: "100dvh" }}>
      {notice}
      <Outlet />
    </ZkMoneyRoot>
  )
}

type NavItem = { label: string; icon: PhoneIconName; path: string }

const NAV_MAIN: NavItem[] = [
  { label: "Home", icon: "home", path: "/" },
  { label: "Contacts", icon: "person", path: "/contacts" },
  { label: "Deposit", icon: "coins", path: "/deposit" },
  { label: "Send", icon: "send", path: "/send" },
  { label: "Receive", icon: "arrow-down", path: "/receive" },
  { label: "Withdraw", icon: "tray-withdraw", path: "/withdraw" },
  { label: "Activity", icon: "history-clock", path: "/activity" },
]
const NAV_PHONE: NavItem[] = [
  { label: "Home", icon: "home", path: "/" },
  { label: "Contacts", icon: "person", path: "/contacts" },
  { label: "Deposit", icon: "coins", path: "/deposit" },
  { label: "Receive", icon: "arrow-down", path: "/receive" },
  { label: "Send", icon: "send", path: "/send" },
  { label: "Withdraw", icon: "tray-withdraw", path: "/withdraw" },
  { label: "Activity", icon: "history-clock", path: "/activity" },
]
const NAV_SETTINGS: NavItem = { label: "Settings", icon: "settings", path: "/settings" }
/** Routes that move money: with a name still waiting for its deposit they raise the activation sheet. */
const ACTIVATION_GATED = new Set(["/deposit", "/send", "/receive", "/withdraw"])

function activePath(pathname: string): string {
  if (pathname.startsWith("/contacts") || pathname.startsWith("/connect")) return "/contacts"
  for (const p of [
    "/activity",
    "/settings",
    "/deposit",
    "/receive",
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
  openShareTag: ShellAction
  openScanner: ShellAction
  scannerAvailable: boolean
}
const ShellActionsContext = createContext<ShellActions | null>(null)

/** Page headers use the same menu and Share entry points as the shell. */
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
  const awaitingActivation = useAwaitingDepositRecord() !== null
  const active = activePath(location.pathname)
  const [open, setOpen] = useState(false)
  const phone = usePhoneLayout()
  const [searchOpen, setSearchOpen] = useState(false)
  const searchButton = useRef<HTMLButtonElement>(null)
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
  const pageHeader = phone && unlocked && mobilePageHeaderPaths.includes(location.pathname)
  const scannerAvailable = enablePhoneScan && phone && unlocked && !!identity?.handle && !identity.pending &&
    !!loadOnboardedIdentity() && hasWalletEntry() && getDesktopL1Bridge() === null
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
      if (!currentIdentity?.handle || currentIdentity.pending || currentIdentity.address !== identity?.address ||
        currentIdentity.handle !== identity.handle || !hasWalletEntry() || !(await getAuthService().getSecretKey())) {
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
    const focused = source ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    return focused?.closest("#wallet-menu") ? menuOpener.current : focused
  }

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    searchButton.current?.focus({ preventScroll: true })
  }, [])
  const openMenu = useCallback<ShellAction>((event) => {
    menuOpener.current = event?.currentTarget ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    setSearchOpen(false)
    setNotificationsOpen(false)
    setOpen(true)
  }, [setNotificationsOpen])
  const openShareTag = useCallback<ShellAction>((event) => {
    const opener = captureOpener(event?.currentTarget)
    setOpen(false)
    setSearchOpen(false)
    setNotificationsOpen(false)
    scanShare.open("share", opener)
  }, [setNotificationsOpen, scanShare.open])
  const openScanner = useCallback<ShellAction>((event) => {
    if (!scannerAvailable) return
    const opener = captureOpener(event?.currentTarget)
    setOpen(false)
    setSearchOpen(false)
    setNotificationsOpen(false)
    scanShare.open("scan", opener)
  }, [scannerAvailable, setNotificationsOpen, scanShare.open])
  const shellActions = useMemo(() => ({ openMenu, openShareTag, openScanner, scannerAvailable }), [openMenu, openShareTag, openScanner, scannerAvailable])

  useEffect(() => {
    if (!unlocked) setSearchOpen(false)
  }, [unlocked])

  useEffect(() => {
    setOpen(false)
    setSearchOpen(false)
  }, [location.key, phone])
  useEffect(() => {
    if (notificationsOpen) {
      setSearchOpen(false)
      setOpen(false)
    }
  }, [notificationsOpen])

  const go = (item: NavItem) => {
    setOpen(false)
    if (awaitingActivation && ACTIVATION_GATED.has(item.path)) openActivationPrompt()
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

  const navigation = (
    <nav
      className={phone ? "ww-sidebar ww-sidebar--open" : "ww-sidebar"}
      aria-label="Primary navigation"
    >
      <div className="ww-sidebar__head">
        <BrandLockup />
        <div className="ww-sidebar__head-actions">
          {scannerAvailable && (
            <button type="button" className="zkm-btn-reset ww-iconbtn" aria-label="Scan QR code" onClick={openScanner}>
              <PhoneIcon name="scan" size={24} />
            </button>
          )}
          <button
            type="button"
            className="zkm-btn-reset ww-iconbtn ww-iconbtn--brand"
            aria-label="Share @tag"
            onClick={openShareTag}
          >
            {phone ? (
              <PhoneIcon name="qr-code" color="#fff" />
            ) : (
              <Icon name="qr-code" size={24} color="#fff" />
            )}
          </button>
          <button
            type="button"
            className="zkm-btn-reset ww-iconbtn"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
          >
            {phone ? <PhoneIcon name="x" color="#fff" /> : <Icon name="x" size={24} />}
          </button>
        </div>
      </div>
      <hr className="ww-divider" />
      <div className="ww-sidebar__menu">
        {(phone ? NAV_PHONE : NAV_MAIN).map(navButton)}
        <hr className="ww-divider" />
        {navButton(NAV_SETTINGS)}
      </div>
      <button
        type="button"
        className="zkm-btn-reset ww-nav-item"
        onClick={() => {
          setOpen(false)
          setSearchOpen(false)
          setNotificationsOpen(false)
          setLogoutPrompt(unlocked && isLogoutBlockedByRegistration() ? "blocked" : "confirm")
        }}
      >
        {phone ? <PhoneIcon name="logout" /> : <Icon name="logout" size={24} />}
        <span>Logout</span>
      </button>
    </nav>
  )

  const account = identity && (!phone || unlocked) && (
    <button
      type="button"
      className="zkm-btn-reset ww-account"
      aria-label={
        identity.handle
          ? `Account settings, @${identity.handle}.zk.money`
          : `Account settings, ${identity.address.slice(0, 8)}… no name yet`
      }
      onClick={() => navigate("/settings")}
    >
      <GradientInitialAvatar
        name={identity.handle ?? identity.address}
        size={40}
        ringed={!phone}
        style={phone ? { padding: 1 } : undefined}
      />
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
    </button>
  )

  return (
    <ShellActionsContext.Provider value={shellActions}>
      <div className={phone && location.pathname === "/" ? "ww-shell ww-shell--home" : "ww-shell"}>
        <div className="ww-shell__glow" aria-hidden />
        <RegistrationDepositPrompt />
        {phone
          ? open && <MobileMenu onClose={() => setOpen(false)}>{navigation}</MobileMenu>
          : navigation}
        <main ref={main} className="ww-main">
          <div className="ww-content">
            {!pageHeader && (
              <div className="ww-shell-header">
                <div className="ww-topbar">
                  {!phone && <TagSearchBar />}
                  <div className="ww-topbar__actions">
                    {phone && account}
                    {unlocked && <NotificationsBell />}
                    {!phone && (
                      <button
                        type="button"
                        className="zkm-btn-reset ww-iconbtn ww-iconbtn--lg"
                        aria-label="Share @tag"
                        onClick={openShareTag}
                      >
                        <Icon name="qr-code" size={24} />
                      </button>
                    )}
                    {!phone && account}
                    {phone && !unlocked && <BrandLockup />}
                    {phone && (
                      <>
                        {unlocked && (
                          <button
                            ref={searchButton}
                            type="button"
                            className="zkm-btn-reset ww-iconbtn"
                            aria-label={searchOpen ? "Close search" : "Open search"}
                            aria-expanded={searchOpen}
                            aria-controls={searchOpen ? "wallet-search" : undefined}
                            onClick={() => {
                              setNotificationsOpen(false)
                              setSearchOpen(!searchOpen)
                            }}
                          >
                            <PhoneIcon name={searchOpen ? "x" : "search"} size={30} color="#fff" />
                          </button>
                        )}
                        <button
                          type="button"
                          className="zkm-btn-reset ww-iconbtn"
                          aria-label="Open menu"
                          aria-haspopup="dialog"
                          aria-expanded={open}
                          aria-controls={open ? "wallet-menu" : undefined}
                          onClick={openMenu}
                        >
                          <PhoneIcon name="menu" size={30} color="#fff" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {phone && unlocked && searchOpen && (
                  <div id="wallet-search" className="ww-mobile-search">
                    <TagSearchBar autoFocus onDismiss={closeSearch} />
                  </div>
                )}
              </div>
            )}
            <Outlet />
          </div>
        </main>
        {logoutPrompt === "blocked" && (
          <LogoutBlockedModal onClose={() => setLogoutPrompt(null)} onConfirm={finishLogout} />
        )}
        {logoutPrompt === "confirm" && (
          <LogoutModal onClose={() => setLogoutPrompt(null)} onConfirm={finishLogout} />
        )}
        {scanShare.session?.surface === "share" && (
          <ShareTagModal key={scanShare.session.id} onClose={() => scanShare.close(scanShare.session!.id)}
            onScan={scannerAvailable ? () => scanShare.switchTo(scanShare.session!.id, "scan") : undefined} />
        )}
        {scanShare.session?.surface === "scan" && (
          <ScannerModal key={scanShare.session.id} onClose={() => scanShare.close(scanShare.session!.id)}
            onShare={() => scanShare.switchTo(scanShare.session!.id, "share")}
            resolvePayload={(payload) => scanShare.resolve(scanShare.session!.id, payload)}
            onDestination={(destination) => scanShare.destination(scanShare.session!.id, destination)} />
        )}
      </div>
    </ShellActionsContext.Provider>
  )
}

/** Bell + dropdown. Closing by any route marks everything read. */
function NotificationsBell() {
  const phone = usePhoneLayout()
  const navigate = useNavigate()
  const [open, setOpen] = useNotificationsPanelOpen()
  const anchorRef = useRef<HTMLDivElement>(null)
  const { entries, hydrated, unreadCount, opened, markAllRead } = useNotificationList()
  // Every unfinished operation, including a sent one this page no longer runs.
  const running = useOperationsInProgress().length > 0
  const tabBound = !!useTabBoundOperation()
  const wasOpen = useRef(open)
  useEffect(() => {
    if (wasOpen.current && !open) void markAllRead()
    wasOpen.current = open
  }, [open, markAllRead])
  const close = useCallback(() => setOpen(false), [setOpen])

  // Entries minted after hydration pop a toast, one at a time; the stored backlog stays behind the
  // bell. An id leaves the queue once its toast has shown.
  const seen = useRef<Set<string> | null>(null)
  const [queue, setQueue] = useState<AppNotificationEntry[]>([])
  const toast = queue[0] ?? null
  useEffect(() => {
    if (!hydrated) return
    if (!seen.current) {
      seen.current = new Set(entries.map(toastKey))
      return
    }
    const fresh = freshToasts(entries, seen.current)
    fresh.forEach((e) => seen.current!.add(toastKey(e)))
    if (fresh.length) setQueue((q) => [...q, ...fresh])
  }, [entries, hydrated])
  const dropToast = useCallback(() => setQueue((q) => q.slice(1)), [])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(dropToast, 8000)
    return () => clearTimeout(t)
  }, [toast, dropToast])
  // Opening the panel shows the same entries; a toast for a dismissed entry has nothing to open.
  useEffect(() => {
    if (open) setQueue([])
  }, [open])
  useEffect(() => {
    if (toast && !entries.some((e) => e.id === toast.id)) dropToast()
  }, [entries, toast, dropToast])
  const openToast = () => {
    if (!toast) return
    opened(toast)
    dropToast()
    const route = notificationRoute(toast)
    if (route) navigate(route.to, route.state ? { state: route.state } : undefined)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!anchorRef.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close()
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open, close])

  return (
    <div className="ww-notifications__anchor" ref={anchorRef}>
      <button
        type="button"
        className="zkm-btn-reset ww-iconbtn ww-iconbtn--lg"
        aria-label={
          running
            ? `Notifications, ${tabBound ? "keep this tab open" : "a transaction is finishing"}`
            : "Notifications"
        }
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {running && (
          <span className={`ww-notifications__bell-ring ${tabBound ? "is-tab-bound" : "is-safe"}`} />
        )}
        {phone ? <PhoneIcon name="bell" color="#fff" /> : <Icon name="bell" size={24} />}
        {unreadCount > 0 && <span className="ww-notifications__bell-dot" />}
      </button>
      {open && <NotificationsPanel onClose={close} />}
      {toast && !open && (
        <Toast
          className="ww-notifications__toast"
          kind={toast.severity === "error" ? "error" : "success"}
          message={`${toast.title}: ${toast.description}`}
          actionLabel={notificationRoute(toast) ? "Open" : undefined}
          onAction={openToast}
          onDismiss={dropToast}
        />
      )}
    </div>
  )
}
