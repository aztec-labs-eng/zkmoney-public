import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { GradientText, Icon } from "@obsidion/web-ds"
import { ActivityListSkeleton } from "../../ui/Skeletons"
import { useActivityEntries } from "../../ui/screens/useActivityEntries"
import { usePhoneLayout } from "../../ui/usePhoneLayout"
import { NonContactRequestsEntry } from "./NonContactRequestsScreen"
import { RequestsUnavailableNotice } from "./RequestsUnavailableNotice"
import { useNonContactRequests } from "./useNonContactRequests"

type Box = "Sent" | "Received"

/**
 * Unpaid requests in one place, under a row for your code. Sent holds the ones you made; Received
 * holds those made to you, with requests from people outside your contacts behind their own entry.
 */
export function RequestsScreen() {
  const navigate = useNavigate()
  const phone = usePhoneLayout()
  const { entries, hydrated, requestsUnavailable, detailModals } = useActivityEntries()
  const [box, setBox] = useState<Box>("Sent")
  const unpaid = entries.filter((e) => e.unpaidRequest)
  const received = unpaid.filter((e) => e.incomingRequest)
  const others = useNonContactRequests().requests.length
  const receivedCount = received.length + others
  const visible = box === "Received" ? received : unpaid.filter((e) => !e.incomingRequest)
  const chip = (label: string, active: boolean, onClick: () => void) => (
    <button
      type="button"
      className="zkm-btn-reset zkm-pressable ww-activity__chip"
      data-active={active || undefined}
      onClick={onClick}
    >
      {label}
    </button>
  )

  const tab = (value: Box, label: string, icon: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={box === value}
      className="zkm-btn-reset ww-request-who__tab"
      onClick={() => setBox(value)}
    >
      <Icon name={icon} size={18} />
      {label}
    </button>
  )

  return (
    <div className="ww-panel ww-receive ww-requests">
      <div className="ww-panel__head">
        <GradientText size={24} weight={700}>
          Requests
        </GradientText>
      </div>
      <div className="ww-panel__scroll ww-requests__body">
        <div className="ww-requests__code">
          <span className="ww-requests__qr" aria-hidden>
            <Icon name="qr-code" size={36} color="#141413" />
          </span>
          <span className="ww-requests__code-text">
            <b>Get paid</b>
            <span>Create a payment code or request link</span>
          </span>
          <div className="ww-chip-row ww-requests__code-actions">
            {chip("New request", true, () => navigate("/receive"))}
          </div>
        </div>
        <div
          className="ww-request-who"
          role="tablist"
          aria-label="Requests"
          data-who={box === "Received" ? "received" : "sent"}
        >
          {tab("Sent", "Sent", "send")}
          {tab("Received", receivedCount ? `Received · ${receivedCount}` : "Received", "receive")}
        </div>
        {box === "Received" && hydrated && requestsUnavailable && <RequestsUnavailableNotice />}
        {!hydrated && <ActivityListSkeleton rows={3} />}
        {hydrated && (
          <div className={`ww-requests__list${phone ? "" : " ww-requests__list--hover"}`}>
            {visible.map((entry) => (phone ? entry.compactNode ?? entry.node : entry.node))}
            {box === "Received" && <NonContactRequestsEntry title="Not in your contacts" />}
            {visible.length === 0 && (box === "Sent" || others === 0) && (
              <span className="ww-requests__empty">
                {box === "Received" ? "No requests to you." : "No requests waiting to be paid."}
              </span>
            )}
          </div>
        )}
      </div>
      {detailModals}
    </div>
  )
}
