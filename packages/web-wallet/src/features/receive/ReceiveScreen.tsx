import { useState } from "react"
import { useNavigate } from "react-router-dom"
import {
  useContactsDirectory,
  type ContactRow as ContactRowData,
  type MintedRequestLink,
} from "@obsidion/front-core"
import { ContactRow, GradientText, Icon, avatarColors } from "@obsidion/web-ds"
import { SharePaylinkModal } from "../requests/SharePaylinkModal"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { useRegistrationDepositOwed } from "../onboarding/openRegistration"
import { openActivationPrompt } from "../onboarding/activationPrompt"
import { RequestContactModal } from "./RequestContactModal"
import { RequestPaylinkModal } from "./RequestPaylinkModal"
import { recentContacts } from "./receiveView"

/**
 * Receive entry page (ULT-671), routed at /receive: a request link, or pick a contact to
 * request from. The flow's steps open as modals over this page.
 */
export function ReceiveScreen() {
  const navigate = useNavigate()
  const identity = loadWalletIdentity()
  const { contacts } = useContactsDirectory()
  const recent = recentContacts(contacts)
  const [paylinkOpen, setPaylinkOpen] = useState(false)
  const [minted, setMinted] = useState<MintedRequestLink>()
  const [requesting, setRequesting] = useState<ContactRowData>()
  // A request names the tag as payee, so until the name is activated the way on is the deposit.
  const awaitingActivation = useRegistrationDepositOwed()

  return (
    <div className="ww-panel ww-panel--entry">
      <div className="ww-panel__head">
        <GradientText size={24} weight={700}>
          Receive
        </GradientText>
      </div>
      <div className="ww-panel__scroll">
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable ww-send-option"
          onClick={() => (awaitingActivation ? openActivationPrompt() : setPaylinkOpen(true))}
        >
          <span className="ww-send-option__body">
            <span className="ww-send-option__icon">
              <Icon name="link" size={24} color="#fff" />
            </span>
            <span className="ww-send-option__text">
              <span>Request link</span>
              <span>Generate a shareable request link. Anyone can pay you, no account needed.</span>
            </span>
          </span>
          <Icon name="chevron-right" size={16} color="var(--text-secondary)" />
        </button>

        <div className="ww-send-or">
          <hr className="ww-divider" />
          <span>or select a contact</span>
          <hr className="ww-divider" />
        </div>

        <div className="ww-contacts__section">
          <span className="ww-contacts__label">Recent contacts</span>
          {recent.length > 0 ? (
            <div className="ww-contacts__group">
              {recent.map((c) => (
                <ContactRow
                  key={c.id}
                  tag={c.tag}
                  name={c.name}
                  colors={avatarColors(c.tag)}
                  onClick={() => setRequesting(c)}
                />
              ))}
            </div>
          ) : (
            <span className="ww-contacts__label ww-contacts__empty">
              No contacts inside of zk.money yet. Direct requests can only go to a @tag, or use a
              request link above.
            </span>
          )}
          <button
            type="button"
            className="zkm-btn-reset ww-send-all"
            onClick={() => navigate("/contacts")}
          >
            View all contacts
          </button>
        </div>
      </div>

      {paylinkOpen && (
        <RequestPaylinkModal
          onClose={() => setPaylinkOpen(false)}
          onCreated={(m) => {
            setPaylinkOpen(false)
            setMinted(m)
          }}
        />
      )}
      {/* The share URL embeds the requester tag, so sharing waits for a registered name. */}
      {minted && identity?.handle && (
        <SharePaylinkModal
          request={minted.row}
          justCreated
          requesterTag={identity.handle}
          onClose={() => setMinted(undefined)}
        />
      )}
      {requesting && (
        <RequestContactModal
          tag={requesting.tag}
          onClose={() => setRequesting(undefined)}
          onRequested={() => navigate(`/contacts/${encodeURIComponent(requesting.id)}`)}
        />
      )}
    </div>
  )
}
