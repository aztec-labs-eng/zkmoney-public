import { useEffect, useMemo, useState } from "react"
import {
  RequestStorage,
  TransactionStorage,
  approvedContactTags,
  globalEventEmitter,
  nonContactInbox,
  useConfigValue,
  useContactsDirectory,
  type PaymentRequest,
  type Transaction,
} from "@obsidion/front-core"
import { webStorage } from "../../platform/storage/WebStorageAdapter"

const TRANSACTIONS_RETRY_MS = 5_000
const MAX_TIMEOUT_MS = 2_147_483_647

/** The earliest expiry not yet passed among pending requests. */
function nextExpiry(requests: readonly PaymentRequest[], now: number): number | undefined {
  let next: number | undefined
  for (const r of requests) {
    if (r.status !== "pending" || r.expiresAt == null || r.expiresAt < now) continue
    if (next === undefined || r.expiresAt < next) next = r.expiresAt
  }
  return next
}

/** Pending requests from people outside the contact book. Empty while the Settings toggle is off. */
export function useNonContactRequests(): {
  requests: PaymentRequest[]
  /** The contacts or the sends could not be read, so no request is listed. The hooks retry. */
  unavailable: boolean
  allowed: boolean
  setAllowed: (allowed: boolean) => Promise<void>
} {
  const { value: allowed, setValue: setAllowed } = useConfigValue("allowNonContactRequests")
  const { contacts, hydrated: contactsHydrated, failed: contactsFailed } = useContactsDirectory()
  const [all, setAll] = useState<PaymentRequest[]>([])
  /** The last good read. A failed read keeps it, so its sends still hide the requests they answered. */
  const [transactions, setTransactions] = useState<Transaction[] | null>(null)
  const [transactionsFailed, setTransactionsFailed] = useState(false)
  /** Changes when a request expires. */
  const [clock, setClock] = useState(0)

  useEffect(() => {
    let active = true
    let reads = 0
    const store = RequestStorage.get()
    const load = () => {
      const read = ++reads
      const current = () => active && read === reads
      store.list().then(
        (rows) => current() && setAll(rows),
        () => current() && setAll([]),
      )
    }
    load()
    const unsubscribe = store.subscribe(load)
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    let active = true
    let reads = 0
    let retry: ReturnType<typeof setTimeout> | undefined
    const load = () => {
      clearTimeout(retry)
      const read = ++reads
      const current = () => active && read === reads
      TransactionStorage.get(webStorage)
        .getTransactions()
        .then(
          (rows) => {
            if (!current()) return
            setTransactions(rows)
            setTransactionsFailed(false)
          },
          (error) => {
            if (!current()) return
            console.warn(error)
            setTransactionsFailed(true)
            retry = setTimeout(load, TRANSACTIONS_RETRY_MS)
          },
        )
    }
    load()
    globalEventEmitter.onTransactionsUpdated(load)
    return () => {
      active = false
      clearTimeout(retry)
      globalEventEmitter.offTransactionsUpdated(load)
    }
  }, [])

  useEffect(() => {
    const now = Date.now()
    const next = nextExpiry(all, now)
    if (next === undefined) return
    const timer = setTimeout(() => setClock((c) => c + 1), Math.min(next - now + 1, MAX_TIMEOUT_MS))
    return () => clearTimeout(timer)
  }, [all, clock])

  // Without a current read of the contacts a requester can be classified wrongly.
  const contactsCurrent = contactsHydrated && !contactsFailed
  const unavailable = allowed && (transactionsFailed || contactsFailed)
  const requests = useMemo(
    // Without a good read of the sends an answered request reads as unanswered.
    () =>
      allowed && contactsCurrent && transactions && !transactionsFailed
        ? nonContactInbox(all, transactions, approvedContactTags(contacts), Date.now())
        : [],
    // `clock` re-runs the expiry check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allowed, contactsCurrent, all, transactions, transactionsFailed, contacts, clock],
  )
  return { requests, unavailable, allowed, setAllowed }
}
