import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Card, PrimaryGradientButton } from "@obsidion/web-ds"
import {
  acknowledgeLostRegistration,
  getPendingStore,
  lostRegistrationNotice,
} from "./webRegistration"

const COPY = {
  taken: {
    title: "Tag not available",
    body: (tag: string) =>
      `@${tag} was claimed by someone else before your registration completed. Your wallet and ` +
      "funds are unaffected — claim a new tag to continue.",
    cta: "Claim a new tag",
    to: "/claim",
  },
  // `failed_terminal` carries no durable reason (exhausted budget and a deterministic rejection
  // close the same phase), so the copy stays true for both causes.
  failed: {
    title: "Registration failed",
    body: (tag: string) =>
      `@${tag} couldn't be claimed right now. Your wallet and funds are unaffected — pick ` +
      "another tag, or try this one again later.",
    cta: "Start over",
    to: "/claim",
  },
  recovery: {
    title: "Tag mismatch",
    body: (tag: string) =>
      `Your account already claimed a tag other than @${tag}. Enter with your passkey to ` +
      "recover it.",
    cta: "Enter with your passkey",
    to: "/enter",
  },
}

/**
 * What the user is owed after a lost name race: the retraction that clears the identity is silent,
 * and the next navigation would otherwise land them on /claim as if they had never been here. Reads
 * the closed record, so it survives the reload; dismissing it is the acknowledgement.
 */
export function LostRegistrationNoticeCard({ onlyTag }: { onlyTag?: string } = {}) {
  const navigate = useNavigate()
  const [notice, setNotice] = useState(lostRegistrationNotice)
  // A race lost mid-session closes the record under the user — surface it without a reload.
  useEffect(() => getPendingStore().onListChanged(() => setNotice(lostRegistrationNotice())), [])

  if (!notice) return null
  // A screen that speaks for one name says nothing about another name's attempt: the notice keeps
  // until a surface that owns no particular name (Home, the landing) can carry it.
  if (onlyTag !== undefined && notice.tag !== onlyTag) return null
  const copy = COPY[notice.kind]
  const dismiss = () => {
    acknowledgeLostRegistration()
    setNotice(null)
  }

  return (
    <Card padding={16} style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span
            className="zkm-type-card-title"
            style={{ flex: 1, color: "var(--text-primary)", fontFamily: "var(--font-display)" }}
          >
            {copy.title}
          </span>
          <button
            type="button"
            className="zkm-btn-reset zkm-type-body-sm"
            style={{ color: "var(--text-secondary)" }}
            onClick={dismiss}
          >
            Dismiss
          </button>
        </div>
        <span className="zkm-type-body-sm" style={{ color: "var(--text-secondary)" }}>
          {copy.body(notice.tag)}
        </span>
        <PrimaryGradientButton
          title={copy.cta}
          buttonStyle="dark"
          onClick={() => {
            dismiss()
            navigate(copy.to)
          }}
        />
      </div>
    </Card>
  )
}
