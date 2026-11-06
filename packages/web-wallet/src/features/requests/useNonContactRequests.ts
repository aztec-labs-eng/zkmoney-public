import { useMemo } from "react"
import {
  nonContactInbox,
  useContactsDirectory,
  useStore,
  type PaymentRequest,
} from "@obsidion/front-core"
import { wallClock } from "../../lib/clock"
import { saveSetting } from "../../platform/storage/deviceKeys"
import { useSession } from "../../session/session"

/** Pending requests from people outside the contact book. Empty while the Settings toggle is off. */
export function useNonContactRequests(): {
  requests: PaymentRequest[]
  /** The contacts could not be read, so no request is listed. The directory retries. */
  unavailable: boolean
  allowed: boolean
  setAllowed: (allowed: boolean) => Promise<void>
} {
  const { requests: store, database, device } = useSession()
  const allowed = useStore(device, (s) => s.allowNonContactRequests)
  const { contacts, hydrated, failed } = useContactsDirectory()
  const all = useStore(store.view)
  const loaded = useStore(store.loaded)
  const now = useStore(wallClock)
  // Without a current read of the contacts a requester can be classified wrongly, and without the
  // payments a paid request reads as pending.
  const current = hydrated && !failed && loaded
  const requests = useMemo(
    () => (allowed && current ? nonContactInbox(all, contacts, now) : []),
    [allowed, current, all, contacts, now],
  )
  return {
    requests,
    unavailable: allowed && failed,
    allowed,
    setAllowed: (on) => saveSetting(database, "allowNonContactRequests", on),
  }
}
