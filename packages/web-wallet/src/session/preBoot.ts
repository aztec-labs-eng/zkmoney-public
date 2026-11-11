import { useLayoutEffect } from "react"
import {
  createPath,
  useNavigate,
  type NavigateFunction,
  type Navigator,
  type To,
} from "react-router-dom"
import { memoryStore, type ReadonlyStore } from "@obsidion/front-core"

/**
 * Taps the pre-boot screen takes for the wallet. "Create Account" waits for the landing the wallet
 * then shows, which runs it once. A route change is the wallet's router's to make: at once when it
 * is up, else as it starts.
 */
export interface PreBoot {
  /** `create`: "Create Account" waits for the wallet. `left`: the screen navigated away. */
  readonly taps: ReadonlyStore<{ create: boolean; left: boolean }>
  setCreate(on: boolean): void
  /** Takes the tap, so it runs once. */
  takeCreate(): boolean
  /** The pre-boot screen's router: its links and navigations become the wallet's. */
  readonly navigator: Navigator
  /** Before the wallet's router first reads the URL. */
  applyNavigation(): void
  /** Inside the wallet's router: from here on the pre-boot screen navigates through it. */
  bind(navigate: NavigateFunction): () => void
}

const pathOf = (to: To) => (typeof to === "string" ? to : createPath(to))

/** The routes the pre-boot landing stands in for. */
const LANDING = ["/", "/claim"]

export function createPreBoot(): PreBoot {
  const taps = memoryStore({ create: false, left: false })
  let pending: { to: string; replace: boolean } | undefined
  let appNavigate: NavigateFunction | undefined
  const leaveTo = (to: To, replace: boolean) => {
    const path = pathOf(to)
    // The landing linking to itself stays up; the wallet still takes the route.
    if (!(LANDING.includes(location.pathname) && LANDING.includes(path)))
      taps.update((t) => ({ ...t, left: true }))
    if (appNavigate) appNavigate(path, { replace })
    else pending = { to: path, replace }
  }
  return {
    taps: taps.readonly,
    setCreate: (create) => taps.update((t) => ({ ...t, create })),
    takeCreate() {
      const { create } = taps.get()
      taps.update((t) => ({ ...t, create: false }))
      return create
    },
    navigator: {
      createHref: pathOf,
      push: (to) => leaveTo(to, false),
      replace: (to) => leaveTo(to, true),
      go: () => {},
    },
    applyNavigation() {
      if (!pending) return
      if (pending.replace) history.replaceState(null, "", pending.to)
      else history.pushState(null, "", pending.to)
      pending = undefined
    },
    bind(navigate) {
      appNavigate = navigate
      return () => {
        if (appNavigate === navigate) appNavigate = undefined
      }
    },
  }
}

/** Inside the wallet's router: hands the pre-boot screen the wallet's navigation. */
export function PreBootRouterBridge({ preBoot }: { preBoot: PreBoot }): null {
  const navigate = useNavigate()
  useLayoutEffect(() => preBoot.bind(navigate), [preBoot, navigate])
  return null
}
