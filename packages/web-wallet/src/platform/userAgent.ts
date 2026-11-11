import { bestEffort } from "@obsidion/core/errors"
import { derived, type QueryFactory, type ReadonlyStore } from "@obsidion/front-core"
import {
  currentUserAgentInfo,
  currentUserAgentInfoSoon,
  type PhoneReach,
  type UserAgentInfo,
} from "@obsidion/passkey-web"
import type { WebAlphaAuthService } from "./auth/WebAlphaAuthService"

/**
 * This browser's claims, probed once a view first subscribes: Client Hints' once they answer,
 * however late, and until then those of a read whose wait for them is bounded.
 */
export function userAgentClaims(query: QueryFactory): ReadonlyStore<UserAgentInfo | undefined> {
  const soon = query<[], UserAgentInfo>("userAgentSoon", { load: currentUserAgentInfoSoon })()
  const hinted = query<[], UserAgentInfo>("userAgent", { load: currentUserAgentInfo })()
  return derived([hinted, soon], (late, early) =>
    late.status === "ready" ? late.value : early.status === "ready" ? early.value : undefined,
  )
}

/** Whether this laptop can reach a phone for a passkey, probed once per page; a failed probe is unknown. */
export const phoneReach = (
  query: QueryFactory,
  auth: Pick<WebAlphaAuthService, "probePhoneReach">,
) =>
  query<[], PhoneReach>("phoneReach", {
    load: async () => (await bestEffort("unknown", auth.probePhoneReach())) ?? "unknown",
  })()
