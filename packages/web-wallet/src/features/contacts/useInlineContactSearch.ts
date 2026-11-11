import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  normalizeTag,
  useInlineAddContact,
  useStore,
  type ContactRow,
  type Contacts,
  type InlineAddedContact,
} from "@obsidion/front-core"
import { accountContacts } from "../../session/contacts"
import { useSession } from "../../session/session"
import { resolveTagForCommit, resolveTagViaRegistry } from "./registryResolution"
import { freshResolutionConfirms, inlinePanelState, shouldResolveInline } from "./contactsView"
import { probeNameAvailability } from "../registration/nameAvailability"

/** Write-through for the shared add-contact hooks over the contact book. */
export async function addContact(
  contacts: Pick<Contacts, "addEntry">,
  name: string,
  address: string,
  email?: string,
  verified?: boolean,
  tag?: string,
): Promise<{ success: boolean; errors?: string }> {
  try {
    await contacts.addEntry({ name, address, email, verified, tag })
    return { success: true }
  } catch (e) {
    // eslint-disable-next-line local/message-in-state -- debt
    return { success: false, errors: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Registry type-ahead behind any contact search field: debounced resolution of a typed @tag with no
 * local match, plus a save that persists only an address a fresh-manifest resolution confirms.
 */
export function useInlineContactSearch(contacts: ContactRow[], query: string) {
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
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current += 1
    }
  }, [])
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => setVerificationError(""), [query])

  const session = useSession()
  const ownTag = useStore(session.identity, (s) => s.value?.handle)
  const resolveTag = useCallback(
    (tag: string) => resolveTagViaRegistry(session.page, tag),
    [session.page],
  )
  const book = useMemo(
    () => ({
      addContact: (name: string, address: string, email?: string, verified?: boolean, tag?: string) =>
        addContact(accountContacts(session), name, address, email, verified, tag),
      getContacts: () => accountContacts(session).all(),
    }),
    [session],
  )
  const inline = useInlineAddContact({
    ...book,
    resolveTag,
    ownTag,
  })

  // The ref dedups re-fires caused by contacts-array refreshes so a registry lookup runs once per tag.
  const lastResolveRequested = useRef<string | null>(null)
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (!shouldResolveInline(contacts, query, ownTag)) {
      lastResolveRequested.current = null
      inline.resolveTag("")
      return
    }
    if (lastResolveRequested.current === query) return
    // eslint-disable-next-line local/timer-in-view -- debt
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
      const fresh = await resolveTagForCommit(session.page, tag)
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

  // Each Registry miss is asked of the claim server, so a later search sees a fresh answer.
  const [answer, setAnswer] = useState<{ tag: string; reserved: boolean } | null>(null)
  const missed = inlinePanelState(contacts, query, inline.lastResolved, ownTag)
  const missedTag = missed.kind === "no-user-found" ? missed.tag : null
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    setAnswer(null)
    if (missedTag === null) return
    let live = true
    void probeNameAvailability(session.page, missedTag).then(({ status }) => {
      if (live) {
        setAnswer({
          tag: missedTag,
          reserved: status === "reserved" || status === "blocked-reserved",
        })
      }
    })
    return () => {
      live = false
    }
  }, [missedTag, session.page])
  const held = answer !== null && answer.tag === missedTag ? answer.reserved : null

  return {
    panel: inlinePanelState(contacts, query, inline.lastResolved, ownTag, held),
    isSaving: verifying || inline.isSaving,
    saveError:
      verificationError || (savedGeneration.current === generation.current ? inline.saveError : ""),
    cancel: () => {
      generation.current += 1
    },
    save,
  }
}
