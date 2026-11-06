/**
 * Whether the sponsored rail can carry a subscribe for this account yet, and why not when it cannot.
 *
 * This answers readiness, not billability: it asks whether this account can ride the sponsored rail
 * at all, and it supplies no operation calls, so it cannot say that any particular batch will be
 * paid for. The route gate uses it to hold flows that would only be refused on chain, and the
 * upgrade to tell an account still being set up on this version.
 */
import { useStore } from "@obsidion/front-core"
import { claimSponsorContext } from "./claimSponsorship"
import { RegistrationPendingError, type RegistrationPending } from "./registrationRail"
import { RAIL_REGISTERED } from "./rails"
import { useSession } from "../../session/session"

/**
 * Why this account cannot ride the sponsored rail yet, or false when it can: it holds a subscription
 * note, or its registration message is ready. A read that cannot answer is `read-error`, which
 * blocks the route and is re-asked on the same timer, so an outage never reads as ready.
 */
export async function sponsoredRailPending(
  deps: Parameters<typeof claimSponsorContext>[0],
): Promise<RegistrationPending | false> {
  try {
    await claimSponsorContext(deps, RAIL_REGISTERED)
    return false
  } catch (error) {
    if (error instanceof RegistrationPendingError) return error.state
    return { pending: "read-error" }
  }
}

/** Why the account last could not ride the sponsored rail; false when it can, undefined unread. */
export type RailPending = RegistrationPending | false | undefined

/**
 * Whether the account still waits to ride the sponsored rail, from the `sponsoredRail` task.
 * A `false` means the account can ride the rail, not that any given batch is paid for.
 */
export function useSponsoredRailPending(): boolean | undefined {
  return useStore(useSession().railPending, (waiting) =>
    waiting === undefined ? undefined : waiting !== false,
  )
}

/** The last read failed: pending above means unknown, not a registration on its way. */
export function useSponsoredRailReadFailed(): boolean {
  return useStore(
    useSession().railPending,
    (waiting) => !!waiting && waiting.pending === "read-error",
  )
}
