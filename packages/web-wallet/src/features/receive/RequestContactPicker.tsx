import { useMemo, useState } from "react"
import { normalizeTag, useContactsDirectory } from "@obsidion/front-core"
import { ContactRow, TextField, avatarColors } from "@obsidion/web-ds"
import { filterContacts } from "../contacts/contactsView"
import { recentPeople } from "../contacts/recentPeople"
import { useContactActivity } from "../contacts/useContactActivity"
import { loadWalletIdentity } from "../identity/walletIdentity"

const RECENT_COUNT = 4

/** Requests from a contact: recent zk.money people, a search over contacts, or a typed @tag, each with its own Request. */
export function RequestContactPicker({
  sending,
  dimmed,
  onRequest,
}: {
  /** The tag whose request is on its way. */
  sending?: string
  /** No amount yet: Request looks off, and a tap still reaches onRequest so the amount can ask for one. */
  dimmed?: boolean
  onRequest: (tag: string) => void
}) {
  const { contacts } = useContactsDirectory()
  const sources = useContactActivity(true)
  const [query, setQuery] = useState("")
  const ownTag = loadWalletIdentity()?.handle

  // Requests travel over messaging, so only zk.money tags can get one.
  const people = useMemo(
    () =>
      (query.trim()
        ? filterContacts(contacts, query)
        : recentPeople(contacts, sources, RECENT_COUNT)
      ).filter((c) => c.addressKind !== "ethereum-l1"),
    [contacts, sources, query],
  )
  const typed = normalizeTag(query)
  const offerTyped =
    !!typed && typed !== ownTag && !people.some((c) => normalizeTag(c.tag) === typed)

  const row = (tag: string, name?: string, key = tag) => {
    const target = normalizeTag(tag) ?? tag
    return (
      <ContactRow
        key={key}
        tag={tag}
        name={name}
        colors={avatarColors(tag)}
        onClick={() => !sending && onRequest(target)}
        trailing={
          <span className="ww-request-pick__ask" data-dimmed={dimmed || undefined}>
            {sending === target ? "Sending…" : "Request"}
          </span>
        }
      />
    )
  }

  return (
    <div className="ww-request-pick">
      <TextField value={query} onChange={setQuery} placeholder="Search a @tag" />
      {!query.trim() && people.length > 0 && <span className="ww-contacts__label">Recent</span>}
      <div className="ww-contacts__group">
        {people.map((c) => row(c.tag, c.name, c.id))}
        {offerTyped && row(typed)}
      </div>
      {!query.trim() && people.length === 0 && (
        <span className="ww-contacts__label ww-contacts__empty">
          No one yet. Search a @tag above.
        </span>
      )}
    </div>
  )
}
