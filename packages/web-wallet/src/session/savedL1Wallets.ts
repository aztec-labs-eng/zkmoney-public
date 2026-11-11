import { useCallback } from "react"
import type { Address } from "viem"
import { isUserLabel, useStore } from "@obsidion/front-core"
import type { Contact, RecordSet } from "@obsidion/front-core"
import { contactBook } from "./contacts"
import { useSession } from "./session"

export interface SavedL1Wallet {
  address: Address
  /** The user's label, else the wallet app it was funded from; unset when neither is known. */
  name?: string
  entry: Contact
}

/** Provider slug of the saved ether.fi Cash address; a real slug, so it never collapses into a manual row. */
export const ETHERFI_PROVIDER = "etherfi"

export const isEtherfiContact = (entry: Contact) =>
  entry.addressKind === "ethereum-l1" && entry.l1Wallet?.provider === ETHERFI_PROVIDER

/** A saved wallet's display name: its label, else the connector name a deposit recorded. */
const savedName = (entry: Contact): string | undefined =>
  isUserLabel(entry.name)
    ? entry.name.trim()
    : isUserLabel(entry.l1Wallet?.walletName)
    ? entry.l1Wallet!.walletName!.trim()
    : undefined

export interface SavedL1WalletList {
  wallets: SavedL1Wallet[]
  loaded: boolean
  failed: boolean
}

/** The `limit` most recent L1 wallet contacts (saved recipients + deposit funders), tombstones hidden. */
function savedL1Wallets(
  { records, loaded, failed }: RecordSet<Contact>,
  limit: number,
): SavedL1WalletList {
  const wallets = records
    .filter((e) => e.addressKind === "ethereum-l1" && !!e.l1Wallet)
    .filter((e) => {
      const w = e.l1Wallet!
      return !w.deletedAt || (w.lastUsedAt ?? 0) > w.deletedAt
    })
    .sort((a, b) => (b.l1Wallet!.lastUsedAt ?? 0) - (a.l1Wallet!.lastUsedAt ?? 0))
    .slice(0, limit)
    .map((e) => ({ address: e.address as Address, name: savedName(e), entry: e }))
  return { wallets, loaded, failed }
}

/** Most-recent L1 wallet contacts (saved recipients + deposit funders), tombstones hidden. */
export const useSavedL1Wallets = (limit = 3): SavedL1Wallet[] => useSavedL1WalletList(limit).wallets

/** `useSavedL1Wallets`, whether the contacts were read, and whether that read failed. */
export function useSavedL1WalletList(limit = 3): SavedL1WalletList {
  const select = useCallback((book: RecordSet<Contact>) => savedL1Wallets(book, limit), [limit])
  return useStore(contactBook(useSession()), select)
}
