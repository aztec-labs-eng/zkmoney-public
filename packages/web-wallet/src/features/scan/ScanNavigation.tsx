import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import type { ScanDestination } from "./scanPayload"

const NavigationContext = createContext<((destination: ScanDestination) => void) | null>(null)

/** Keeps destination focus ownership alive when /link or /request replaces SidebarLayout. */
export function ScanNavigationProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const pending = useRef<ScanDestination | null>(null)
  const [attempt, setAttempt] = useState(0)
  const handoff = useCallback((destination: ScanDestination) => {
    pending.current = destination
    setAttempt((value) => value + 1)
    navigate(destination.to, { state: destination.state })
  }, [navigate])

  useEffect(() => {
    const destination = pending.current
    if (!destination) return
    pending.current = null
    if (`${location.pathname}${location.hash}` !== destination.to) return
    const root = document.querySelector<HTMLElement>(".zkm-root")
    if (!root) return
    const focused = document.activeElement
    // The destination's search or confirmation may already have claimed focus.
    if (focused instanceof HTMLElement && focused !== document.body && (
      focused.closest("dialog[open]") ||
      (root.contains(focused) && !focused.closest(".ww-shell-header, .ww-sidebar") && focused !== root)
    )) return
    const target = root.querySelector<HTMLElement>(".ww-panel") ?? root.querySelector<HTMLElement>("main") ?? root
    if (!target.hasAttribute("tabindex")) target.tabIndex = -1
    target.focus({ preventScroll: true })
  }, [attempt, location.key, location.pathname, location.hash])

  return <NavigationContext.Provider value={handoff}>{children}</NavigationContext.Provider>
}

export function useScanNavigation() {
  const handoff = useContext(NavigationContext)
  return useCallback((destination: ScanDestination) => {
    if (!handoff) throw new Error("Scanner navigation requires AppShell")
    handoff(destination)
  }, [handoff])
}
