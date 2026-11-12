import { bestEffort } from "@obsidion/core/errors"
import { useNavigate } from "react-router-dom"
import { useStore } from "@obsidion/front-core"
import { Card, PrimaryGradientButton } from "@obsidion/web-ds"
import { useSession } from "../../../session/session"
import {
  acknowledgeLostRegistration,
  lostRegistrationNotice,
} from "../../registration/webRegistration"
import { fmt } from "../../../lib/fmt"
import copy from "./LostRegistrationNoticeCard.copy"

const COPY = {
  taken: { ...copy.taken, to: "/claim" },
  failed: { ...copy.failed, to: "/claim" },
  recovery: { ...copy.recovery, to: "/enter" },
}

/**
 * What the user is owed after a lost name race: the retraction that clears the identity is silent,
 * and the next navigation would otherwise land them on /claim as if they had never been here. Reads
 * the closed record, so it survives the reload; dismissing it is the acknowledgement.
 */
export function LostRegistrationNoticeCard() {
  const navigate = useNavigate()
  // A race lost mid-session closes the record under the user: it surfaces without a reload.
  const { registrations } = useSession()
  const notice = useStore(
    registrations.view,
    () => lostRegistrationNotice(registrations),
    (a, b) => a?.kind === b?.kind && a?.tag === b?.tag,
  )

  if (!notice) return null
  const text = COPY[notice.kind]
  const dismiss = () => void bestEffort("unknown", acknowledgeLostRegistration(registrations))

  return (
    <Card padding={16} style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span
            className="zkm-type-card-title"
            style={{ flex: 1, color: "var(--text-primary)", fontFamily: "var(--font-display)" }}
          >
            {text.title}
          </span>
          <button
            type="button"
            className="zkm-btn-reset zkm-type-body-sm"
            style={{ color: "var(--text-secondary)" }}
            onClick={dismiss}
          >
            {copy.dismiss}
          </button>
        </div>
        <span className="zkm-type-body-sm" style={{ color: "var(--text-secondary)" }}>
          {fmt(text.body, { tag: notice.tag })}
        </span>
        <PrimaryGradientButton
          title={text.cta}
          buttonStyle="secondary"
          onClick={() => {
            dismiss()
            navigate(text.to)
          }}
        />
      </div>
    </Card>
  )
}
