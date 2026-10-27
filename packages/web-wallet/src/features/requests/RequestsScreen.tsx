import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { selectRequests } from "@obsidion/front-core"
import { GradientText, Icon } from "@obsidion/web-ds"
import { fmt } from "../../lib/fmt"
import { ActivityDetailHost, useActivityHost } from "../../ui/activity/ActivityDetailHost"
import { ActivityRow } from "../../ui/activity/ActivityRow"
import { ActivityListSkeleton } from "../../ui/Skeletons"
import { usePhoneLayout } from "../../ui/usePhoneLayout"
import { NonContactRequestsEntry } from "./NonContactRequestsScreen"
import { RequestsUnavailableNotice } from "./RequestsUnavailableNotice"
import copy from "./RequestsScreen.copy"
import { useNonContactRequests } from "./useNonContactRequests"

type Box = "sent" | "received"

/**
 * Unpaid requests in one place, under a row for your code. Sent holds the ones you made; Received
 * holds those made to you, with requests from people outside your contacts behind their own entry.
 */
export function RequestsScreen() {
  return (
    <ActivityDetailHost>
      <Requests />
    </ActivityDetailHost>
  )
}

function Requests() {
  const navigate = useNavigate()
  const phone = usePhoneLayout()
  const { feed } = useActivityHost()
  const [box, setBox] = useState<Box>("sent")
  const others = useNonContactRequests().requests.length
  const { sent, received, receivedCount } = selectRequests(feed, others)
  const visible = box === "received" ? received : sent
  const { hydrated } = feed

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
          {copy.title}
        </GradientText>
      </div>
      <div className="ww-panel__scroll ww-requests__body">
        <div className="ww-requests__code">
          <span className="ww-requests__qr" aria-hidden>
            <Icon name="qr-code" size={36} color="#141413" />
          </span>
          <span className="ww-requests__code-text">
            <b>{copy.getPaid}</b>
            <span>{copy.getPaidBody}</span>
          </span>
          <div className="ww-chip-row ww-requests__code-actions">
            <button
              type="button"
              className="zkm-btn-reset zkm-pressable ww-activity__chip"
              data-active
              onClick={() => navigate("/receive")}
            >
              {copy.newRequest}
            </button>
          </div>
        </div>
        <div className="ww-request-who" role="tablist" aria-label={copy.tabs.label} data-who={box}>
          {tab("sent", copy.tabs.sent, "send")}
          {tab(
            "received",
            receivedCount
              ? fmt(copy.tabs.receivedCount, { count: receivedCount })
              : copy.tabs.received,
            "receive",
          )}
        </div>
        {box === "received" && hydrated && feed.requestsUnavailable && (
          <RequestsUnavailableNotice />
        )}
        {!hydrated && <ActivityListSkeleton rows={3} />}
        {hydrated && (
          <div className={`ww-requests__list${phone ? "" : " ww-requests__list--hover"}`}>
            {visible.map((item) => (
              <ActivityRow key={item.id} item={item} compact={phone} />
            ))}
            {box === "received" && <NonContactRequestsEntry title={copy.notInContacts} />}
            {visible.length === 0 && (box === "sent" || others === 0) && (
              <span className="ww-requests__empty">
                {box === "received" ? copy.emptyReceived : copy.emptySent}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
