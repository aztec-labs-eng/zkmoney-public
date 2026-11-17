import { useStore } from "@obsidion/front-core"
import { useSession } from "../../session/session"
import { offerFailed, shownOffer, type GoldenTicketOffer } from "./ticketOffer"

/** The offer read as a page sees it. `offer` is undefined while the read is in flight or failed. */
export interface GoldenTicketOfferRead {
  offer: GoldenTicketOffer | null | undefined
  /** The read failed, so nothing is confirmed either way: no signup mode can be chosen on it. */
  failed: boolean
  retry: () => void
}

/** The session page's offer. */
export function useGoldenTicketOffer(): GoldenTicketOfferRead {
  const entry = useSession().page.ticketOffer
  const offer = useStore(entry, shownOffer)
  const failed = useStore(entry, offerFailed)
  return { offer, failed, retry: entry.refresh }
}
