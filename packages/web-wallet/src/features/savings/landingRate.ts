import { bestEffort, type QueryEntry, type QueryFactory } from "@obsidion/front-core"
import { withTimeout } from "../../lib/withTimeout"
import type { PageFacts } from "../../session/pageChain"

/** How long the landing waits on the live rate before it shows without one. */
const LANDING_RATE_WAIT_MS = 2_000

/** Sky's yearly rate at `RATE_SCALE`; undefined when unread. */
export type LiveRate = { rate: bigint | undefined }
export type LandingRate = QueryEntry<LiveRate>

/**
 * Sky's live rate, with no account: what the landing advertises. Read once per page, started by the
 * boot as soon as the config is up. A failed or slow read settles without a rate.
 */
export const landingRate = (query: QueryFactory, { chain }: PageFacts): LandingRate =>
  query<[], LiveRate>("landingRate", {
    load: async () => {
      const price = await bestEffort(
        "holding.rateUnread",
        withTimeout(chain.savingsPrice.read(), LANDING_RATE_WAIT_MS),
      )
      return { rate: price?.rate }
    },
  })()
