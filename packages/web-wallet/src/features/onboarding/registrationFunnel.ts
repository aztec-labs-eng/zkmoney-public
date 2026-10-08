/**
 * Registration-deposit funnel reporters (ULT-777): shown → funded → swept, each latched in
 * wallet storage so reloads and the several surfaces that can observe one registration (the
 * onboarding panel, the activity feed row, the detail modal, the manual sweep) never
 * double-count. Keys carry the SIPA address / account only locally — no event does.
 */
import type { RegistrationKind } from "@obsidion/core/types"
import { fireEvent } from "../../lib/analytics"
import { walletStorage } from "../../platform/storage/walletStorage"

const REPORTED_KEY = "webwallet.registration.reported"
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

/** The pay-to address became visible (onboarding panel or the feed's detail modal), and on which
 *  schedule the deposit it asks for was quoted. */
export function reportRegistrationDepositShown(sipaAddress: string, kind?: RegistrationKind): void {
  if (!latch(`shown:${sipaAddress}`)) return
  fireEvent("registration_deposit_shown", kind === undefined ? undefined : { kind })
}

/** Funds first seen at the address; `sinceStartMs` from the durable record's startTime. */
export function reportRegistrationDepositFunded(sipaAddress: string, sinceStartMs: number): void {
  if (!latch(`funded:${sipaAddress}`)) return
  fireEvent("registration_deposit_funded", { duration_ms: lap(sinceStartMs) })
}

/** The deposit left the address for the portal (relayer-observed or manual sweep). */
export function reportRegistrationDepositSwept(account: string, sinceFundedMs: number): void {
  if (!latch(`swept:${account}`)) return
  fireEvent("registration_deposit_swept", { duration_ms: lap(sinceFundedMs) })
}
