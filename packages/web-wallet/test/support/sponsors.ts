import { createPace } from "@obsidion/core/cadence"
import { memoryStore, queries } from "@obsidion/front-core"
import { pageSponsors } from "../../src/features/registration/sponsorAccounts"
import { createSubscriptionChecks } from "../../src/session/session"

/**
 * A session's sponsor parts over an auth that records no account, so every batch pays with its
 * own note, and over `chain`. One per suite keeps its subscription answers across cases.
 */
export const selfPayingSession = (chain?: unknown) => ({
  page: { sponsors: pageSponsors({ accountRecord: async () => undefined } as never), chain },
  subscriptionChecks: createSubscriptionChecks(
    queries({ pace: createPace(), visible: memoryStore(true).readonly, now: () => Date.now() }),
  ),
})

/** A session's subscription checks whose PXE read answers `held` for every key. */
export function checksHolding(held: boolean) {
  const checks = createSubscriptionChecks(
    queries({ pace: createPace(), visible: memoryStore(true).readonly, now: () => Date.now() }),
  )
  return {
    ...checks,
    held: (check: { toString(): string }) =>
      checks.held({ toString: () => String(check), read: async () => held }),
  }
}
