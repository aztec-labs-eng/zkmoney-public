/**
 * Registration-deposit funnel reporters: shown, funded, swept and lapsed. Each fires from
 * the store write that first sets its field, so reloads and the surfaces that observe one
 * registration never double-count. No event carries the address or the account.
 */
import { isTicketSignup, type RegistrationChange } from "@obsidion/front-core"
import type { fireOnboardingEvent } from "../../lib/analytics"

export function lap(ms: number): number {
  return Math.max(0, Math.round(ms))
}

/** Reports, through `fire`, what each committed change first set. */
export const registrationFunnel =
  (fire: typeof fireOnboardingEvent) =>
  (changes: readonly RegistrationChange[]): void => {
    for (const { record, first } of changes) {
      const set = new Set(first)
      // A ticket signup's link funds the address, which it never shows.
      if (set.has("startTime") && !isTicketSignup(record.terms)) {
        if (record.route) fire("registration_deposit_shown", { route: record.route })
        else fire("registration_deposit_shown")
      }
      if (set.has("firstFundedAt") && record.firstFundedAt !== undefined)
        fire("registration_deposit_funded", {
          duration_ms: lap(record.firstFundedAt - record.startTime),
        })
      if (set.has("sweptAt") && record.sweptAt !== undefined)
        fire("registration_deposit_swept", {
          duration_ms: lap(record.sweptAt - (record.fundedAt ?? record.startTime)),
        })
      if (set.has("lapsedAt")) fire("registration_lapsed", { phase: record.phase })
    }
  }
