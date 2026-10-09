import { useMemo } from "react"
import { useNavigate } from "react-router-dom"
import {
  recentContacts,
  useContactsDirectory,
  type ContactRow as DirectoryRow,
} from "@obsidion/front-core"
import { ContactRow, GradientText, Icon, avatarColors } from "@obsidion/web-ds"
import { PhoneIcon } from "../../ui/PhoneIcon"
import { useShellActions } from "../../ui/AppShell"
import { usePhoneLayout } from "../../ui/usePhoneLayout"
import { useBack } from "../../ui/hooks"
import { TagSearchBar } from "./TagSearchBar"
import { useContactActivity } from "./useContactActivity"
import emptyArt from "../../assets/contacts/empty-contacts.webp"
import { MessagingBanner } from "../../platform/xmtp/MessagingBanner"
import { NonContactRequestsEntry } from "../requests/NonContactRequestsScreen"

function ContactGroup({ label, contacts, phone }: {
  label: string
  contacts: DirectoryRow[]
  phone: boolean
}) {
  const navigate = useNavigate()
  return (
    <div className="ww-contacts__section">
      <span className="ww-contacts__label">{label}</span>
      <div className="ww-contacts__group">
        {contacts.map((c) => (
          <ContactRow
            key={c.id}
            tag={c.tag}
            name={c.name}
            isL1={c.addressKind === "ethereum-l1"}
            colors={avatarColors(c.tag)}
            avatarStyle={phone ? { fontSize: 28, fontWeight: 500 } : undefined}
            trailing={phone ? <PhoneIcon name="chevron-right" size={16} color="#bfc2d7" /> : undefined}
            onClick={() => navigate(`/contacts/${encodeURIComponent(c.id)}`)}
          />
        ))}
      </div>
    </div>
  )
}

/** The phone owns its header and shared search; desktop keeps the shell search, and Add contact
 *  sends the cursor there. */
export function ContactsScreen() {
  const navigate = useNavigate()
  const { contacts } = useContactsDirectory()
  const phone = usePhoneLayout()
  const { openScanner, scannerAvailable } = useShellActions()
  const back = useBack("/")
  const sources = useContactActivity(phone)
  const recent = useMemo(() => recentContacts(contacts, sources), [contacts, sources])

  return (
    <div className="ww-panel ww-contacts">
      <div className="ww-panel__head ww-contacts__head">
        {phone && (
          <button type="button" className="zkm-btn-reset zkm-pressable ww-contacts__back" aria-label="Back" onClick={back}>
            <span className="zkm-glass-circle zkm-glass-circle--faint ww-contacts__back-disc">
              <PhoneIcon name="arrow-left" size={24} color="#fff" />
            </span>
          </button>
        )}
        <GradientText size={24} weight={700}>
          Contacts
        </GradientText>
        {!phone && (
          <button
            type="button"
            className="zkm-btn-reset zkm-pressable ww-contacts__add"
            onClick={() => navigate("/contacts", { replace: true, state: { searchFocus: true } })}
          >
            <Icon name="user-follow" size={16} color="#fff" />
            Add contact
          </button>
        )}
      </div>
      {phone && (
        <div className="ww-contacts__search">
          <TagSearchBar />
          {scannerAvailable && (
            <button type="button" className="zkm-btn-reset zkm-pressable ww-contacts__search-action"
              aria-label="Scan QR code" onClick={openScanner}>
              <PhoneIcon name="scan" size={20.16} color="#fff" />
            </button>
          )}
        </div>
      )}
      <MessagingBanner />
      {contacts.length === 0 ? (
        <>
          <NonContactRequestsEntry className="ww-contacts__requests-entry" />
          <div className="ww-empty">
            <img src={emptyArt} alt="" width={88} height={86} />
            <GradientText size={18} weight={700}>
              No contacts yet
            </GradientText>
            <span>Add contacts by searching for your friends @tags</span>
          </div>
        </>
      ) : (
        <div className="ww-panel__scroll">
          <NonContactRequestsEntry />
          {phone && recent.length > 0 && <ContactGroup label="Recent contacts" contacts={recent} phone={phone} />}
          <ContactGroup label="All contacts" contacts={contacts} phone={phone} />
        </div>
      )}
    </div>
  )
}
