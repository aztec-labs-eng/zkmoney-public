import { useEffect, useId, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { normalizeTag, useContactsDirectory } from "@obsidion/front-core"
import {
  ContactRow,
  GradientSpinner,
  Icon,
  IconCircle,
  ListRow,
  RowChevron,
  avatarColors,
} from "@obsidion/web-ds"
import { PhoneIcon } from "../../ui/PhoneIcon"
import { usePhoneLayout } from "../../ui/usePhoneLayout"
import { filterContacts } from "./contactsView"
import { useInlineContactSearch } from "./useInlineContactSearch"

/**
 * Top-bar @tag search: the Contacts search (local filter + inline registry resolution) in a pill
 * with a dropdown of results. Picking a row opens the person; an unsaved tag opens unsaved, and its
 * page carries Add contact.
 */
export function TagSearchBar({
  autoFocus = false,
  onDismiss,
  initialQuery = "",
}: {
  autoFocus?: boolean
  onDismiss?: () => void
  initialQuery?: string
} = {}) {
  const phone = usePhoneLayout()
  const navigate = useNavigate()
  const location = useLocation()
  const input = useRef<HTMLInputElement>(null)
  const consumed = useRef<string | undefined>(undefined)
  const { contacts, refresh } = useContactsDirectory()
  const [query, setQuery] = useState(initialQuery)
  const [focused, setFocused] = useState(false)
  const resultId = useId()
  const root = useRef<HTMLDivElement>(null)
  const inline = useInlineContactSearch(contacts, query, refresh)

  const dismiss = () => {
    inline.cancel()
    setFocused(false)
  }
  const dismissRef = useRef(dismiss)
  dismissRef.current = dismiss

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) dismissRef.current()
    }
    document.addEventListener("pointerdown", onDown)
    return () => document.removeEventListener("pointerdown", onDown)
  }, [])

  useEffect(() => {
    const state = location.state as Record<string, unknown> | null
    const seed = typeof state?.searchTag === "string" ? state.searchTag : undefined
    if (
      location.pathname !== "/contacts" ||
      (seed === undefined && state?.searchFocus !== true) ||
      consumed.current === location.key
    )
      return
    consumed.current = location.key
    const rest = { ...state }
    delete rest.searchTag
    delete rest.searchFocus
    navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      { replace: true, state: Object.keys(rest).length ? rest : null },
    )
    // Contacts' Add button: an empty field, ready to type into.
    if (seed === undefined) {
      setFocused(true)
      input.current?.focus()
      return
    }
    const tag = normalizeTag(seed)
    if (!tag) return
    dismissRef.current()
    setQuery(tag)
    setFocused(true)
    input.current?.focus()
  }, [location, navigate])

  const go = (id: string) => {
    setQuery("")
    setFocused(false)
    navigate(`/contacts/${encodeURIComponent(id)}`)
  }

  const filtered = query.trim() ? filterContacts(contacts, query) : []
  const panel = inline.panel
  const open = focused && (filtered.length > 0 || panel.kind !== "none")

  return (
    <div
      className="ww-search"
      ref={root}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node))
          dismiss()
      }}
    >
      {phone ? <PhoneIcon name="search-field" size={18} color="#fdfdfd" /> : <Icon name="search" size={18} />}
      <input
        ref={input}
        type="search"
        aria-label="Search @tag"
        aria-controls={open ? resultId : undefined}
        autoFocus={autoFocus}
        placeholder="Search @tag"
        inputMode="search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setFocused(true)
        }}
        onFocus={() => setFocused(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation()
            dismiss()
            onDismiss?.()
          }
        }}
      />
      <span className="ww-search__suffix">.zk.money</span>
      {open && (
        <div
          className="ww-search__results"
          id={resultId}
          role="region"
          aria-label="Contact search results"
        >
          {filtered.map((c) => (
            <ContactRow
              key={c.id}
              className="ww-search__row"
              tag={c.tag}
              name={c.name}
              isL1={c.addressKind === "ethereum-l1"}
              colors={avatarColors(c.tag)}
              trailing={phone ? <PhoneIcon name="chevron-right" size={16} color="#bfc2d7" /> : undefined}
              onClick={() => go(c.id)}
            />
          ))}
          {panel.kind === "looking-up" && (
            <div className="ww-search__row ww-search__row--static">
              <GradientSpinner size={48} />
              <span className="ww-search__status">Looking up…</span>
            </div>
          )}
          {panel.kind === "add-offer" && (
            <button
              type="button"
              className="zkm-btn-reset ww-search__row"
              aria-label={`Open @${panel.tag}`}
              onClick={() => go(panel.tag)}
            >
              <ListRow
                title={`@${panel.tag}`}
                subtitle="zk.money"
                leading={<IconCircle name="user-follow" glyphSize={24} />}
                trailing={
                  <span className="ww-search__trailing">
                    Not a contact
                    {phone ? <PhoneIcon name="chevron-right" size={16} color="#bfc2d7" /> : <RowChevron />}
                  </span>
                }
              />
            </button>
          )}
          {panel.kind === "no-user-found" && (
            <ListRow
              className="ww-search__row ww-search__row--static"
              title="User not found"
              subtitle="To find a user type full @tag"
              leading={<IconCircle name="user-unfollow" glyphSize={24} />}
            />
          )}
        </div>
      )}
    </div>
  )
}
