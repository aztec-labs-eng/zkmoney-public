import { useCallback, useRef, useState } from "react"
import type { Contact, RegistryTagResolution } from "../core"
import { normalizeTag } from "../utils"

interface AddContactResponse {
  success: boolean
  errors?: string
}

interface UseInlineAddContactArgs {
  addContact: (
    name: string,
    address: string,
    email?: string,
    verified?: boolean,
    tag?: string,
  ) => Promise<AddContactResponse>
  getContacts: () => Promise<Contact[]>
  refreshContacts: () => Promise<void>
  /** Platform binding of Registry tag resolution (chain, RPC, manifest). */
  resolveTag: (tag: string) => Promise<RegistryTagResolution>
  /** The user's own tag; adding it is rejected. */
  ownTag?: string
}

export type InlineResolveStatus = "resolving" | "found" | "not_found"

export interface InlineResolveResult {
  tag: string
  status: InlineResolveStatus
  /** Set only when `status === "found"`. Cached so the save step doesn't have
   *  to re-resolve. */
  address?: string
}

export interface InlineAddedContact {
  tag: string
  address: string
}

/**
 * Inline counterpart to `useAddContactSheet`. Splits the sheet's combined
 * resolve+save into two phases driven by the recipient search surface:
 *
 *   • `resolveTag(tag)` — fired as the user types (debounced by the caller,
 *     only when the query has no exact local-contact match). Sets
 *     `lastResolved` so the noMatchesState panel can render "Looking up…",
 *     "Add @<tag>", or "No user found for @<tag>". Stale responses are
 *     ignored — only the most recent `resolveTag` call can win.
 *
 *   • `saveResolvedTag(tag)` — fired on the Add-CTA tap. Uses the cached
 *     address from `lastResolved` to skip a second RPC, writes through
 *     `addContact`, refreshes the directory, and returns
 *     `{tag, address}` so the caller can open the new contact's chat.
 */
export function useInlineAddContact({
  addContact,
  getContacts,
  refreshContacts,
  resolveTag: resolveTagViaRegistry,
  ownTag,
}: UseInlineAddContactArgs) {
  const [lastResolved, setLastResolved] = useState<InlineResolveResult | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState("")

  // Tag of the most-recent `resolveTag` call. Used to discard stale RPC
  // responses when the user keeps typing.
  const currentResolveTagRef = useRef<string | null>(null)

  // A second Add tap lands before `isSaving` re-renders, so the state flag can't gate re-entry.
  // Without this both saves clear the duplicate check and the second write throws out of storage.
  const savingRef = useRef(false)

  const resolveTag = useCallback(
    async (rawTag: string) => {
      const tag = normalizeTag(rawTag)
      if (!tag) {
        currentResolveTagRef.current = null
        setLastResolved(null)
        return
      }

      currentResolveTagRef.current = tag
      setLastResolved({ tag, status: "resolving" })

      try {
        const result = await resolveTagViaRegistry(tag)
        if (currentResolveTagRef.current !== tag) return // stale
        if (result.status !== "resolved") {
          // notFound + staleRollup both collapse to "not_found" — the inline
          // panel has no distinct stale-rollup surface (that copy lives on the
          // full add-contact sheet).
          setLastResolved({ tag, status: "not_found" })
          return
        }
        setLastResolved({ tag, status: "found", address: result.l2Address })
      } catch {
        if (currentResolveTagRef.current !== tag) return
        setLastResolved({ tag, status: "not_found" })
      }
    },
    [resolveTagViaRegistry],
  )

  const saveResolvedTag = useCallback(
    async (rawTag: string): Promise<InlineAddedContact | null> => {
      const tag = normalizeTag(rawTag)
      if (!tag || savingRef.current) return null

      const cached = lastResolved
      const address =
        cached && cached.tag === tag && cached.status === "found" ? cached.address : undefined
      if (!address) {
        setSaveError("Tag not resolved yet")
        return null
      }

      savingRef.current = true
      setIsSaving(true)
      setSaveError("")
      try {
        if (ownTag && normalizeTag(ownTag) === tag) {
          setSaveError(`@${tag}.zk.money is your own tag`)
          return null
        }

        const entries = await getContacts()
        // Already saved (including entries the payment directory hides, so the search surface never
        // matched it locally) — the caller opens the contact either way.
        const existing = entries.find((e) => e.tag === tag)
        if (existing) return { tag, address: existing.address }

        const response = await addContact(tag, address, undefined, undefined, tag)
        if (!response.success) {
          setSaveError(response.errors ?? "Could not add contact")
          return null
        }

        await refreshContacts()
        return { tag, address }
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "Could not add contact")
        return null
      } finally {
        savingRef.current = false
        setIsSaving(false)
      }
    },
    [addContact, getContacts, lastResolved, refreshContacts, ownTag],
  )

  return { lastResolved, isSaving, saveError, resolveTag, saveResolvedTag }
}
