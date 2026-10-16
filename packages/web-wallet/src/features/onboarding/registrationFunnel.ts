/**
 * Registration-deposit funnel reporters (ULT-777): shown → funded → swept, each latched in
 * wallet storage so reloads and the several surfaces that can observe one registration (the
 * onboarding panel, the activity feed row, the detail modal, the manual sweep) never
 * double-count. Keys carry the SIPA address / account only locally — no event does.
 */
import { fireOnboardingEvent } from "../../lib/analytics"
import { walletStorage } from "../../platform/storage/walletStorage"
import { getPendingStore } from "./webRegistration"

const REPORTED_KEY = "webwallet.registration.reported"
const ROUTE_KEY = "webwallet.registration.route"

/** How the open registration's tag was got, as registration_deposit_shown reports it. */
export const REGISTRATION_ROUTES = ["random", "paid", "invite", "past_user", "ticket"] as const

export type RegistrationRoute = (typeof REGISTRATION_ROUTES)[number]

const memory = new Set<string>()

/** True exactly once per key; storage failure degrades to a page-lifetime latch. */
function latch(key: string): boolean {
  if (memory.has(key)) return false
  memory.add(key)
  try {
    const map = JSON.parse(walletStorage.getItem(REPORTED_KEY) ?? "{}") as Record<string, true>
    if (map[key]) return false
    map[key] = true
    walletStorage.setItem(REPORTED_KEY, JSON.stringify(map))
  } catch {
    // In-memory latch already set.
  }
  return true
}

function lap(ms: number): number {
  return Math.max(0, Math.round(ms))
}

/** Remembers how `tag` was got, for the registration this browser starts on it. */
export function rememberRegistrationRoute(tag: string, route: RegistrationRoute): void {
  try {
    walletStorage.setItem(ROUTE_KEY, JSON.stringify({ tag, route }))
  } catch {
    // The deposit's report then names no route.
  }
}

/** How `tag` was got, if this browser remembered it. */
export function registrationRouteFor(tag: string): RegistrationRoute | undefined {
  try {
    const saved = JSON.parse(walletStorage.getItem(ROUTE_KEY) ?? "null") as {
      tag?: string
      route?: RegistrationRoute
    } | null
    return saved?.tag === tag ? saved.route : undefined
  } catch {
    return undefined
  }
}

/** The route remembered for the current registration, if `sipaAddress` is its address. */
function shownRoute(sipaAddress: string): string | undefined {
  try {
    const record = getPendingStore().current()
    const saved = JSON.parse(walletStorage.getItem(ROUTE_KEY) ?? "null") as {
      tag?: string
      route?: string
    } | null
    const current = record?.sipaAddress.toLowerCase() === sipaAddress.toLowerCase()
    return current && saved?.tag === record?.tag ? saved?.route : undefined
  } catch {
    return undefined
  }
}

/** The pay-to address became visible (onboarding panel or the feed's detail modal). */
export function reportRegistrationDepositShown(sipaAddress: string): void {
  if (!latch(`shown:${sipaAddress}`)) return
  const route = shownRoute(sipaAddress)
  if (route) fireOnboardingEvent("registration_deposit_shown", { route })
  else fireOnboardingEvent("registration_deposit_shown")
}

/** Funds first seen at the address; `sinceStartMs` from the durable record's startTime. */
export function reportRegistrationDepositFunded(sipaAddress: string, sinceStartMs: number): void {
  if (!latch(`funded:${sipaAddress}`)) return
  fireOnboardingEvent("registration_deposit_funded", { duration_ms: lap(sinceStartMs) })
}

/** The deposit left the address for the portal (relayer-observed or manual sweep). */
export function reportRegistrationDepositSwept(account: string, sinceFundedMs: number): void {
  if (!latch(`swept:${account}`)) return
  fireOnboardingEvent("registration_deposit_swept", { duration_ms: lap(sinceFundedMs) })
}
