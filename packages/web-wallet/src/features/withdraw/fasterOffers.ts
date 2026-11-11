import { bestEffort } from "@obsidion/core/errors"
import { within, type QueryFactory } from "@obsidion/front-core"
import {
  fasterWithdrawalOffer,
  type FasterWithdrawalQuote,
  type QuotedOffer,
} from "./useFasterWithdrawal"
import { SWAP_QUOTE_MAX_AGE_MS, SWAP_QUOTE_REFRESH_MS } from "./swapQuotes"

/**
 * The account's faster option, quoted again every {@link SWAP_QUOTE_REFRESH_MS} while a view offers
 * it, since waiting moves the burn later in its epoch. A quote that fails, or runs past
 * {@link SWAP_QUOTE_MAX_AGE_MS} and is aborted, offers nothing as of when it ended. `now` stamps
 * each quote.
 */
export function fasterOffers(
  query: QueryFactory,
  load: (signal: AbortSignal) => Promise<FasterWithdrawalQuote>,
  now: () => number,
) {
  return query<[], QuotedOffer>("fasterOffer", {
    load: async (signal) => {
      const quotedAt = now()
      const quoting = new AbortController()
      const quoted = await bestEffort(
        "unknown",
        within(load(quoting.signal), "fasterOffer", { ms: SWAP_QUOTE_MAX_AGE_MS, signal }).finally(
          () => quoting.abort(),
        ),
      )
      return quoted
        ? {
            offer: fasterWithdrawalOffer(quoted),
            eta: { standardSeconds: quoted.estimate.standardEtaSeconds },
            quotedAt,
          }
        : { quotedAt: now() }
    },
    poll: SWAP_QUOTE_REFRESH_MS,
    stale: SWAP_QUOTE_MAX_AGE_MS,
  })()
}

export type FasterOffer = ReturnType<typeof fasterOffers>
