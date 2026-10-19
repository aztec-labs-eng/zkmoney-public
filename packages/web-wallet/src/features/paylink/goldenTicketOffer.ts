import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { AccountServiceClient } from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { createExternalState } from "../../lib/externalState"
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
export async function fetchGoldenTicketOffer(): Promise<GoldenTicketOffer | null> {
  const info = await new AccountServiceClient(getConfig().accountServiceUrl, {
    readOnly: true,
  }).domainInfo()
  const ticket = info.goldenTicket
  if (!ticket?.schedule) return null
  // A threshold no note can be compared against is a failed read, not an offer.
  if (!isBaseUnits(ticket.threshold)) throw new Error("invalid golden ticket threshold")
  return { threshold: ticket.threshold, schedule: ticket.schedule }
}

/** The offer read as a page sees it. `offer` is undefined while the read is in flight or failed. */
export interface GoldenTicketOfferRead {
  offer: GoldenTicketOffer | null | undefined
  /** The read failed, so nothing is confirmed either way: no signup mode can be chosen on it. */
  failed: boolean
  retry: () => void
}

let prefetched: Promise<GoldenTicketOffer | null> | undefined
const prefetchedOffer = createExternalState<{ offer: GoldenTicketOffer | null } | undefined>(
  undefined,
)

/** Starts the read before the page that shows it mounts; that page's first read takes it. */
export function prefetchGoldenTicketOffer(): void {
  if (prefetched) return
  prefetched = fetchGoldenTicketOffer()
  prefetched.then(
    (offer) => prefetchedOffer.set({ offer }),
    () => {},
  )
}

/** The prefetched offer once it has landed. */
export function usePrefetchedGoldenTicketOffer(): GoldenTicketOffer | null | undefined {
  return useSyncExternalStore(prefetchedOffer.subscribe, prefetchedOffer.get)?.offer
}

export function useGoldenTicketOffer(): GoldenTicketOfferRead {
  // A prefetch that already landed shows from the first frame, for the read that takes it.
  const [offer, setOffer] = useState<GoldenTicketOffer | null | undefined>(() =>
    prefetched ? prefetchedOffer.get()?.offer : undefined,
  )
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    const early = attempt === 0 ? prefetched : undefined
    prefetched = undefined
    if (!early) {
      setOffer(undefined)
      setFailed(false)
    }
    ;(early ?? fetchGoldenTicketOffer()).then(
      (result) => {
        if (live) setOffer(result)
      },
      () => {
        if (live) setFailed(true)
      },
    )
    return () => {
      live = false
    }
  }, [attempt])
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { offer, failed, retry }
}
