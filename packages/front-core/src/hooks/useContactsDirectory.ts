import { useCallback, useEffect, useRef, useState } from "react"
import { ContactStorage } from "../core"
import type { Contact } from "../core"
import { isZeroAddress, shortenAddressSm } from "../utils"

export interface ContactRow {
  id: string
  name: string
  tag: string
  address: string
  addressKind: "aztec-l2" | "ethereum-l1"
  provider?: string
  provenance?: "deposit-attested" | "saved-recipient"
  /** See `Contact.autoAdded`. */
  autoAdded?: boolean
}

export function isPaymentContactEntry(entry: Contact): boolean {
  const addressKind = entry.addressKind ?? "aztec-l2"
  if (!entry.address) return false
  // Hide any zero-address contact a token mint may have persisted before the
  // upsert guard landed (see `upsertDepositL1WalletContact`). A mint isn't a
  // routable wallet — it shouldn't pollute the directory as "External Wallet"
  // / "0x000…". This read-time filter also keeps it out of every consumer that
  // scans `contacts` (resolveWalletLabel, the tx-detail contact enrichment).
  if (isZeroAddress(entry.address)) return false
  // L1 wallets removed by the user survive in storage as tombstones (see
  // ContactL1Wallet.deletedAt) — hide them here too.
  if (entry.l1Wallet?.deletedAt !== undefined) return false
  return addressKind === "ethereum-l1" || (addressKind === "aztec-l2" && !!entry.tag)
}

export function contactRowFromEntry(entry: Contact): ContactRow {
  const isL1 = (entry.addressKind ?? "aztec-l2") === "ethereum-l1"
  // The payment directory only carries L1 wallets and tagged L2 contacts (see
  // `isPaymentContactEntry`, which gates this map). Pending handshake rows are
  // filtered out upstream, so a non-L1 entry here is always a routable L2
  // contact — collapse the kind accordingly.
  const addressKind: "aztec-l2" | "ethereum-l1" = isL1 ? "ethereum-l1" : "aztec-l2"
  const tag = isL1 ? shortenAddressSm(entry.address) : entry.tag!
  const provider = entry.l1Wallet?.provider ?? "unknown"

  return {
    id: isL1 ? `l1:${provider}:${entry.address.toLowerCase()}` : entry.tag!,
    name: entry.name,
    tag,
    address: entry.address,
    addressKind,
    provider: entry.l1Wallet?.provider,
    provenance: entry.l1Wallet?.provenance,
    ...(entry.autoAdded && { autoAdded: true }),
  }
}

const CONTACTS_RETRY_MS = 5_000

/**
 * Contacts directory built on top of `ContactStorage`. ContactStorage exposes only async accessors; this hook adds a
 * `useState<ContactRow[]>` cache so the UI re-renders on add/refresh, plus `lookup(tag)` / `lookupByAddress` accessors.
 * Platform wrappers layer on focus-driven refresh and any native serialization.
 */
export function useContactsDirectory() {
  const [contacts, setContacts] = useState<ContactRow[]>([])
  /** Before the first read completes, an empty `contacts` does not mean there are no contacts. */
  const [hydrated, setHydrated] = useState(false)
  /** The last read failed. `contacts` keeps the last good read; the hook retries. */
  const [failed, setFailed] = useState(false)
  const mounted = useRef(false)
  /** Numbers each read, so an older read that finishes after a newer one is not applied. */
  const reads = useRef(0)

  const refresh = useCallback(async () => {
    const read = ++reads.current
    const current = () => mounted.current && read === reads.current
    try {
      const entries = await ContactStorage.get().getEntries()
      if (!current()) return
      setContacts(entries.filter(isPaymentContactEntry).map(contactRowFromEntry))
      setHydrated(true)
      setFailed(false)
    } catch (error) {
      if (current()) setFailed(true)
      throw error
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    let active = true
    let retry: ReturnType<typeof setTimeout> | undefined
    const reload = () => {
      clearTimeout(retry)
      const read = refresh()
      const number = reads.current
      read.catch((error) => {
        console.warn(error)
        if (active && number === reads.current) retry = setTimeout(reload, CONTACTS_RETRY_MS)
      })
    }
    reload()
    const unsubscribe = ContactStorage.get().onChange(reload)
    return () => {
      active = false
      mounted.current = false
      clearTimeout(retry)
      unsubscribe()
    }
  }, [refresh])

  const lookup = useCallback(
    (idOrTag: string): ContactRow | undefined =>
      contacts.find((c) => c.id === idOrTag || c.tag === idOrTag),
    [contacts],
  )

  // Address-keyed L2 lookup. Reads from the already-loaded `contacts` list —
  // no additional storage reads. Case-insensitive defensively; Aztec L2
  // addresses canonicalize lowercase but a manually-entered contact might
  // not. L1 contacts are excluded so an ETH/L2 address collision (40 vs 64
  // hex chars makes this near-impossible anyway) can never confuse the
  // activity feed.
  const lookupByAddress = useCallback(
    (address: string): ContactRow | undefined => {
      const needle = address.toLowerCase()
      return contacts.find(
        (c) => c.addressKind !== "ethereum-l1" && c.address.toLowerCase() === needle,
      )
    },
    [contacts],
  )

  return { contacts, hydrated, failed, refresh, lookup, lookupByAddress }
}
