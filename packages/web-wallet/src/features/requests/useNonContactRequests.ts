import { useMemo } from "react"
import {
  nonContactInbox,
  useConfigValue,
  useContactsDirectory,
  useStore,
  type PaymentRequest,
} from "@obsidion/front-core"
import { wallClock } from "../../lib/clock"
import { useSession } from "../../platform/session"

/** Pending requests from people outside the contact book. Empty while the Settings toggle is off. */
export function useNonContactRequests(): {
  requests: PaymentRequest[]
  /** The contacts could not be read, so no request is listed. The directory retries. */
  unavailable: boolean
  allowed: boolean
  setAllowed: (allowed: boolean) => Promise<void>
} {
  const { value: allowed, setValue: setAllowed } = useConfigValue("allowNonContactRequests")
  const { contacts, hydrated, failed } = useContactsDirectory()
  const all = useStore(useSession().requests.view)
  const now = useStore(wallClock)
  // Without a current read of the contacts a requester can be classified wrongly.
  const current = hydrated && !failed
  const requests = useMemo(
    () => (allowed && current ? nonContactInbox(all, contacts, now) : []),
    [allowed, current, all, contacts, now],
  )
  return { requests, unavailable: allowed && failed, allowed, setAllowed }
}
