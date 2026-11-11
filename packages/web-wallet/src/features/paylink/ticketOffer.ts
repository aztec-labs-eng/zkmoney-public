import {
  AccountServiceClient,
  WalletError,
  type QueryEntry,
  type QueryFactory,
  type QueryState,
} from "@obsidion/front-core"
import type { WebWalletConfig } from "../../config/env"
import { isBaseUnits } from "./ticketThreshold"

/** What the claim server offers a paylink signup: the threshold and the reduced schedule it buys. */
export interface GoldenTicketOffer {
  threshold: string
  schedule: { fee: string; minDeposit: string }
}

/**
 * Null when the network issues no tickets (none configured, or paused), or the server predates the
 * schedule in `/domain/info`: without the schedule the wallet cannot price the slice before
 * spending a ticket, so the link is claimed on Home after an ordinary signup instead.
 */
async function fetchGoldenTicketOffer(config: WebWalletConfig): Promise<GoldenTicketOffer | null> {
  const info = await new AccountServiceClient(config.accountServiceUrl, {
    readOnly: true,
  }).domainInfo()
  const ticket = info.goldenTicket
  if (!ticket?.schedule) return null
  // A threshold no note can be compared against is a failed read, not an offer.
  if (!isBaseUnits(ticket.threshold))
    throw new WalletError("unknown", "invalid golden ticket threshold")
  return { threshold: ticket.threshold, schedule: ticket.schedule }
}

/**
 * The page's offer, read again by each view that opens after the last one closed. The pre-boot
 * visitor page reads it early; the app's first screen opens while that page still shows, so it
 * takes the same read.
 */
export function pageTicketOffer(
  query: QueryFactory,
  config: WebWalletConfig,
): QueryEntry<GoldenTicketOffer | null> {
  return query<[], GoldenTicketOffer | null>("goldenTicketOffer", {
    load: () => fetchGoldenTicketOffer(config),
    stale: 0,
  })()
}

export type PageTicketOffer = ReturnType<typeof pageTicketOffer>

/**
 * The offer a view shows: none while it is read again or after a failed re-read, so a stale read
 * never wins.
 */
export const shownOffer = (s: QueryState<GoldenTicketOffer | null>) =>
  s.status === "ready" && !s.refreshing && s.error === undefined ? s.value : undefined

/** The last read failed, first or again: nothing is confirmed either way. */
export const offerFailed = (s: QueryState<GoldenTicketOffer | null>) =>
  s.status === "failed" || (s.status === "ready" && s.error !== undefined)
