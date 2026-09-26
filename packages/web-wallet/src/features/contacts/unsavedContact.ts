import {
  ContactStorage,
  normalizeTag,
  TagValidationError,
  type Contact,
} from "@obsidion/front-core"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { addContact } from "./useInlineContactSearch"
import { resolveTagForCommit, resolveTagViaRegistry } from "./registryResolution"

/**
 * A registered tag opened from search but not saved. The contact page and its Send and Request
 * rails run on it; nothing is written until the user taps Add contact.
 */
export function unsavedContact(tag: string, l2Address: string): Contact {
  return { name: tag, tag, address: l2Address, addressKind: "aztec-l2" }
}

/** The unsaved contact a route names, or null when it is not someone else's registered tag. */
export async function lookUpUnsavedContact(idOrTag: string): Promise<Contact | null> {
  const tag = normalizeTag(idOrTag)
  const own = loadWalletIdentity()?.handle
  if (!tag || (own && normalizeTag(own) === tag)) return null
  try {
    const resolution = await resolveTagViaRegistry(tag)
    return resolution.status === "resolved" ? unsavedContact(tag, resolution.l2Address) : null
  } catch (e) {
    if (e instanceof TagValidationError) return null
    throw e
  }
}

/**
 * Save an unsaved contact, but only the address the page showed and a fresh manifest still
 * confirms. "changed" means the registry moved on since the page resolved it.
 */
export async function saveUnsavedContact(contact: Contact): Promise<"added" | "changed"> {
  const tag = contact.tag
  if (!tag) return "changed"
  const fresh = await resolveTagForCommit(tag)
  if (fresh.status !== "resolved" || fresh.l2Address !== contact.address) return "changed"
  const entries = await ContactStorage.get().getEntries()
  if (entries.some((e) => e.tag === tag)) return "added"
  const saved = await addContact(tag, contact.address, undefined, undefined, tag)
  if (!saved.success) throw new Error(saved.errors ?? "Could not add contact")
  return "added"
}
