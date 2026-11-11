import {
  WalletError,
  memoryStore,
  selectContactDirectory,
  useStore,
  type ContactDirectory,
  type Contacts,
  type ReadonlyStore,
  type RecordSet,
  type StoredContact,
} from "@obsidion/front-core"
import { useSession, type Session } from "./session"

const NO_CONTACTS = memoryStore<RecordSet<StoredContact>>({
  records: [],
  loaded: true,
  failed: false,
}).readonly

/** The account's contact book; a visitor's is empty. */
export const contactBook = (
  open: Pick<Session, "contacts">,
): ReadonlyStore<RecordSet<StoredContact>> => open.contacts?.view ?? NO_CONTACTS

/** The payment directory over the account's contact book. */
export const useContactDirectory = (): ContactDirectory =>
  useStore(contactBook(useSession()), selectContactDirectory)

/** The account's contact book, for flows only an account reaches. */
export function accountContacts(open: Pick<Session, "contacts">): Contacts {
  if (!open.contacts) throw new WalletError("wallet.notReady", "no account session")
  return open.contacts
}
