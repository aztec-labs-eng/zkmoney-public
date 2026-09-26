import { useCallback, useState } from "react"
import type { Contact, RegistryTagResolution } from "../core"
import { normalizeTag } from "../utils"

type AddContactState = "idle" | "resolving" | "success" | "error"

interface AddContactResponse {
  success: boolean
  errors?: string
}

interface UseAddContactSheetArgs {
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

/**
 * Owns the add-contact sheet visibility, the
 * `idle | resolving | success | error` state machine, and the resolve+save
 * pipeline (normalize → self/duplicate check → `resolveTag` → handle
 * `staleRollup` → `addContact` → refresh → 2-second success reset).
 *
 * 2s success-reset timer is not cancelled on unmount; safe today only because
 * the consumer is the long-lived Payments tab. If reused from a transient
 * component, add a cleanup ref before relying on it.
 */
export function useAddContactSheet({
  addContact,
  getContacts,
  refreshContacts,
  resolveTag,
  ownTag,
}: UseAddContactSheetArgs) {
  const [state, setState] = useState<AddContactState>("idle")
  const [error, setError] = useState("")
  const [visible, setVisible] = useState(false)
  const [initialTag, setInitialTag] = useState("")

  const open = useCallback((nextInitialTag: string = "") => {
    setError("")
    setInitialTag(nextInitialTag)
    setVisible(true)
  }, [])

  const onDismiss = useCallback(() => {
    setVisible(false)
    setError("")
  }, [])

  const onSubmit = useCallback(
    async (form: { tag: string; name: string }) => {
      const tag = normalizeTag(form.tag)
      if (!tag) return

      const contactName = form.name?.trim() || tag

      setState("resolving")
      setError("")

      try {
        if (ownTag && normalizeTag(ownTag) === tag) {
          setState("error")
          setError(`@${tag}.zk.money is your own tag`)
          return
        }

        const entries = await getContacts()
        const existing = entries.find((entry) => entry.tag === tag)
        if (existing) {
          setState("error")
          setError(`@${tag}.zk.money is already in your contacts`)
          return
        }

        const result = await resolveTag(tag)

        if (result.status === "staleRollup") {
          setState("error")
          setError(`@${tag}.zk.money hasn't upgraded to the current network yet`)
          return
        }
        if (result.status !== "resolved") {
          setState("error")
          setError(`No user found for @${tag}.zk.money`)
          return
        }

        const response = await addContact(contactName, result.l2Address, undefined, undefined, tag)
        if (!response.success) {
          setState("error")
          setError(response.errors ?? "Could not add contact")
          return
        }
        await refreshContacts()

        setState("success")
        setVisible(false)
        setTimeout(() => setState("idle"), 2000)
      } catch (err) {
        setState("error")
        setError(err instanceof Error ? err.message : "Could not resolve tag")
      }
    },
    [addContact, getContacts, refreshContacts, resolveTag, ownTag],
  )

  return {
    sheetProps: {
      visible,
      initialTag,
      isResolving: state === "resolving",
      errorMessage: error,
      onDismiss,
      onSubmit,
    },
    open,
  }
}
