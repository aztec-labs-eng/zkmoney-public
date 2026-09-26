import { useEffect, useRef, useState } from "react"
import {
  ContactStorage,
  normalizeTag,
  useInlineAddContact,
  type ContactRow,
  type InlineAddedContact,
} from "@obsidion/front-core"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { resolveTagForCommit, resolveTagViaRegistry } from "./registryResolution"
import { freshResolutionConfirms, inlinePanelState, shouldResolveInline } from "./contactsView"

/** Write-through for the shared add-contact hooks over ContactStorage. */
export async function addContact(
  name: string,
  address: string,
  email?: string,
  verified?: boolean,
  tag?: string,
): Promise<{ success: boolean; errors?: string }> {
  try {
    await ContactStorage.get().addEntry({ name, address, email, verified, tag })
    return { success: true }
  } catch (e) {
    return { success: false, errors: e instanceof Error ? e.message : String(e) }
  }
}

export const getContacts = () => ContactStorage.get().getEntries()

/**
 * Registry type-ahead behind any contact search field: debounced resolution of a typed @tag with no
 * local match, plus a save that persists only an address a fresh-manifest resolution confirms.
 */
export function useInlineContactSearch(
  contacts: ContactRow[],
  query: string,
  refreshContacts: () => Promise<void>,
) {
  const [verifying, setVerifying] = useState(false)
  const [verificationError, setVerificationError] = useState("")
  const saving = useRef(false)
  const generation = useRef(0)
  const savedGeneration = useRef<number | undefined>(undefined)
  const mounted = useRef(false)
  const currentQuery = useRef(query)
  if (currentQuery.current !== query) {
    currentQuery.current = query
    generation.current += 1
  }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current += 1
    }
  }, [])
  useEffect(() => setVerificationError(""), [query])

  const ownTag = loadWalletIdentity()?.handle
  const inline = useInlineAddContact({
    addContact,
    getContacts,
    refreshContacts,
    resolveTag: resolveTagViaRegistry,
    ownTag,
  })

  // The ref dedups re-fires caused by contacts-array refreshes so a registry lookup runs once per tag.
  const lastResolveRequested = useRef<string | null>(null)
  useEffect(() => {
    if (!shouldResolveInline(contacts, query, ownTag)) {
      lastResolveRequested.current = null
      inline.resolveTag("")
      return
    }
    if (lastResolveRequested.current === query) return
    const timer = setTimeout(() => {
      lastResolveRequested.current = query
      void inline.resolveTag(query)
    }, 300)
    return () => clearTimeout(timer)
  }, [query, contacts, inline.resolveTag])

  const save = async (tag: string): Promise<InlineAddedContact | null> => {
    if (saving.current || normalizeTag(currentQuery.current) !== tag) return null
    saving.current = true
    const request = generation.current
    savedGeneration.current = request
    const active = () => mounted.current && generation.current === request
    setVerifying(true)
    setVerificationError("")
    try {
      const fresh = await resolveTagForCommit(tag)
      if (!active()) return null
      if (!freshResolutionConfirms(inline.lastResolved, tag, fresh)) {
        setVerificationError("Contact details changed. Check the result and try again.")
        await inline.resolveTag(tag)
        return null
      }
      return await inline.saveResolvedTag(tag)
    } catch {
      if (active()) setVerificationError("Couldn't verify this contact. Try adding it again.")
      return null
    } finally {
      saving.current = false
      if (mounted.current) setVerifying(false)
    }
  }

  return {
    panel: inlinePanelState(contacts, query, inline.lastResolved, ownTag),
    isSaving: verifying || inline.isSaving,
    saveError:
      verificationError || (savedGeneration.current === generation.current ? inline.saveError : ""),
    cancel: () => {
      generation.current += 1
    },
    save,
  }
}
