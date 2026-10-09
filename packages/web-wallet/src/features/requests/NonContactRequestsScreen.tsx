import { useState } from "react"
import { useNavigate } from "react-router-dom"
import type { PaymentRequest } from "@obsidion/front-core"
import {
  GlassCircleButton,
  GradientInitialAvatar,
  GradientText,
  Icon,
  avatarColors,
} from "@obsidion/web-ds"
import { useBack } from "../../ui/hooks"
import { requestAmountLabel } from "../../ui/format"
import { declineRequestById } from "../contacts/requestActions"
import { IncomingRequestDetailModal } from "./IncomingRequestDetailModal"
import { RequestsUnavailableNotice } from "./RequestsUnavailableNotice"
import {
  NON_CONTACT_REQUESTS_PATH,
  requestMeta,
  requesterHandle,
  requestersSummary,
} from "./nonContactView"
import { useNonContactRequests } from "./useNonContactRequests"

/** Contacts-page link into the inbox; nothing while the inbox is empty or turned off. */
export function NonContactRequestsEntry({ className }: { className?: string }) {
  const navigate = useNavigate()
  const { requests } = useNonContactRequests()
  if (requests.length === 0) return null
  const tags = [...new Set(requests.map((r) => r.contactTag))]
  return (
    <button
      type="button"
      className={["zkm-btn-reset zkm-pressable ww-noncontacts-entry", className]
        .filter(Boolean)
        .join(" ")}
      onClick={() => navigate(NON_CONTACT_REQUESTS_PATH)}
    >
      <span className="ww-noncontacts-entry__avatars" aria-hidden>
        {tags.slice(0, 3).map((tag) => (
          <GradientInitialAvatar key={tag} name={tag} colors={avatarColors(tag)} size={40} />
        ))}
      </span>
      <span className="ww-noncontacts-entry__text">
        <span className="ww-noncontacts-entry__title">
          Requests from people not in your contacts
        </span>
        <span className="ww-noncontacts-entry__summary">{requestersSummary(requests)}</span>
      </span>
      <span className="ww-noncontacts-entry__count">{requests.length}</span>
      <Icon name="arrow-right-s-line" size={14} color="#fdfdfd" />
    </button>
  )
}

function RequestRow({
  request,
  now,
  onDecline,
  onView,
}: {
  request: PaymentRequest
  now: number
  onDecline: () => void
  onView: () => void
}) {
  return (
    <div className="ww-noncontacts__row">
      <GradientInitialAvatar
        name={request.contactTag}
        colors={avatarColors(request.contactTag)}
        size={40}
      />
      <span className="ww-noncontacts__who">
        <span className="ww-noncontacts__name">
          <span className="ww-noncontacts__tag">{requesterHandle(request.contactTag)}</span>
          <span className="ww-noncontacts__pill">Not in your contacts</span>
        </span>
        <span className="ww-noncontacts__meta">{requestMeta(request, now)}</span>
      </span>
      <span className="ww-noncontacts__amount">{requestAmountLabel(request.amount)}</span>
      <span className="ww-noncontacts__actions">
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable ww-noncontacts__action"
          onClick={onDecline}
        >
          Decline
        </button>
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable ww-noncontacts__action ww-noncontacts__action--primary"
          onClick={onView}
        >
          View
        </button>
      </span>
    </div>
  )
}

/**
 * The separate inbox for payment requests from people outside the contact book. They never reach
 * Activity, Home or notifications; paying one saves the requester as a contact.
 */
export function NonContactRequestsScreen() {
  const navigate = useNavigate()
  const back = useBack("/contacts")
  const { requests, allowed, unavailable } = useNonContactRequests()
  const [detailId, setDetailId] = useState<string | null>(null)
  // Closes when the request leaves the list: expired, answered, declined, or no longer checkable.
  const detail = requests.find((r) => r.id === detailId)
  const [decliningAll, setDecliningAll] = useState(false)
  const now = Date.now()

  const decline = (id: string) => void declineRequestById(id).catch(console.warn)
  const declineAll = async () => {
    setDecliningAll(true)
    try {
      for (const request of requests) await declineRequestById(request.id).catch(console.warn)
    } finally {
      setDecliningAll(false)
    }
  }
  // Same route as the Activity feed's Send-on-request; ContactPayScreen saves the unsaved requester.
  const pay = (request: PaymentRequest) =>
    navigate(`/contacts/${encodeURIComponent(request.contactTag)}/send`, {
      state: {
        request: {
          id: request.id,
          tag: request.contactTag,
          amount: request.amount,
          note: request.note,
        },
      },
    })

  return (
    <div className="ww-panel ww-noncontacts">
      <div className="ww-noncontacts__head">
        <GlassCircleButton ariaLabel="Back" onClick={back}>
          <Icon
            name="chevron-right"
            size={16}
            color="var(--text-secondary)"
            style={{ transform: "rotate(180deg)" }}
          />
        </GlassCircleButton>
        <GradientText size={18} weight={600} className="ww-noncontacts__title">
          Requests from <span>non-contacts</span>
        </GradientText>
        {requests.length > 0 && (
          <button
            type="button"
            className="zkm-btn-reset zkm-pressable ww-noncontacts__decline-all"
            disabled={decliningAll}
            onClick={() => void declineAll()}
          >
            Decline all
          </button>
        )}
      </div>
      <div className="ww-panel__scroll">
        <p className="ww-noncontacts__explainer">
          <Icon name="information-line" size={16} />
          These people are not in your contacts. Their requests stay here and never show in Activity
          or notifications. Paying a request adds the person to your contacts.
        </p>
        {unavailable ? (
          <RequestsUnavailableNotice />
        ) : requests.length > 0 ? (
          <div className="ww-contacts__group">
            {requests.map((request) => (
              <RequestRow
                key={request.id}
                request={request}
                now={now}
                onDecline={() => decline(request.id)}
                onView={() => setDetailId(request.id)}
              />
            ))}
          </div>
        ) : (
          <p className="ww-noncontacts__empty">
            {allowed
              ? "No requests from people outside your contacts."
              : "Requests from people outside your contacts are turned off."}
          </p>
        )}
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable ww-noncontacts__settings"
          onClick={() => navigate("/settings")}
        >
          {allowed
            ? "Don't want these? Turn off requests from non-contacts in Settings"
            : "Turn on requests from non-contacts in Settings"}
          <Icon name="chevron-right" size={16} color="var(--text-secondary)" />
        </button>
      </div>
      {detail && (
        <IncomingRequestDetailModal
          request={detail}
          fromNonContact
          onClose={() => setDetailId(null)}
          onDecline={() => {
            decline(detail.id)
            setDetailId(null)
          }}
          onSend={() => pay(detail)}
        />
      )}
    </div>
  )
}
