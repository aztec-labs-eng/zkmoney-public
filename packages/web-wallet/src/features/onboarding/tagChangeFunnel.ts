/**
 * Tag-change funnel reporters (ZKM-1516): opened → route chosen → confirmed → funded → registered,
 * or abandoned at a step. Onboarding stream, so no event carries a tag, address or exact amount.
 */
import { amountBucket, fireOnboardingEvent } from "../../lib/analytics"
import { walletStorage } from "../../platform/storage/walletStorage"
import type { WithdrawalSpeed } from "../withdraw/WithdrawalSpeedPicker"
import { lap, latch } from "./registrationFunnel"

const FUNDED_KEY = "webwallet.tagChange.funded"

export const TAG_CHANGE_ROUTES = ["pay", "invite", "past_user"] as const
export type TagChangeRoute = (typeof TAG_CHANGE_ROUTES)[number]

/** Where a tag change stopped: the name sheet, the confirm modal, the new passkey, the batch. */
export const TAG_CHANGE_STEPS = ["sheet", "confirm", "account", "funding"] as const
export type TagChangeStep = (typeof TAG_CHANGE_STEPS)[number]

/** `cancelled` is the user's own exit; the rest are the funding guard's refusals or a failure. */
export const TAG_CHANGE_REASONS = [
  "cancelled",
  "balance_short",
  "records_pending",
  "savings_held",
  "allowance_short",
  "passkey_refused",
  "failed",
] as const
export type TagChangeReason = (typeof TAG_CHANGE_REASONS)[number]

/** Settings → Change, for a settled identity. */
export function reportTagChangeOpened(): void {
  fireOnboardingEvent("tag_change_opened")
}

export function reportTagChangeRouteChosen(route: TagChangeRoute): void {
  fireOnboardingEvent("tag_change_route_chosen", { route })
}

/** Change tag pressed in the confirm modal; the balance leaves only as its amount range. */
export function reportTagChangeConfirmed(
  balance: bigint,
  decimals: number,
  speed: WithdrawalSpeed,
): void {
  fireOnboardingEvent("tag_change_confirmed", {
    amount_bucket: amountBucket(balance, decimals),
    speed,
  })
}

/** The funding batch mined. Remembers when, for the registered lap after the switch reloads. */
export function reportTagChangeFunded(tag: string, sinceConfirmedMs: number): void {
  if (!latch(`tag_change_funded:${tag}`)) return
  try {
    walletStorage.setItem(FUNDED_KEY, JSON.stringify({ tag, at: Date.now() }))
  } catch {
    // tag_change_registered then carries no duration.
  }
  fireOnboardingEvent("tag_change_funded", { duration_ms: lap(sinceConfirmedMs) })
}

/** The new account's registration sweep confirmed. */
export function reportTagChangeRegistered(tag: string): void {
  if (!latch(`tag_change_registered:${tag}`)) return
  let fundedAt: number | undefined
  try {
    const saved = JSON.parse(walletStorage.getItem(FUNDED_KEY) ?? "null") as {
      tag?: string
      at?: number
    } | null
    if (saved?.tag === tag && typeof saved.at === "number") fundedAt = saved.at
  } catch {
    // No duration.
  }
  if (fundedAt === undefined) fireOnboardingEvent("tag_change_registered")
  else fireOnboardingEvent("tag_change_registered", { duration_ms: lap(Date.now() - fundedAt) })
}

export function reportTagChangeAbandoned(step: TagChangeStep, reason: TagChangeReason): void {
  fireOnboardingEvent("tag_change_abandoned", { step, reason })
}
