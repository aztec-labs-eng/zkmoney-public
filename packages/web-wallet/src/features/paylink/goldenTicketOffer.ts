import { useCallback, useEffect, useState } from "react"
import { AccountServiceClient } from "@obsidion/front-core"
import { getConfig } from "../../config/env"

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
  return { threshold: ticket.threshold, schedule: ticket.schedule }
}

/** The offer read as a page sees it. `offer` is undefined while the read is in flight or failed. */
export interface GoldenTicketOfferRead {
  offer: GoldenTicketOffer | null | undefined
  /** The read failed, so nothing is confirmed either way: no signup mode can be chosen on it. */
  failed: boolean
  retry: () => void
}

export function useGoldenTicketOffer(): GoldenTicketOfferRead {
  const [offer, setOffer] = useState<GoldenTicketOffer | null>()
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    setOffer(undefined)
    setFailed(false)
    fetchGoldenTicketOffer().then(
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
