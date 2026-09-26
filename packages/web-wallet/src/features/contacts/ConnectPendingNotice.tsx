import { useState } from "react"
import { Card } from "@obsidion/web-ds"
import { hasConnectStash } from "./connectReceive"

/**
 * Signup and sign-in context for a visitor who opened a connect link: the link waits in this tab
 * and asks to add the contact once they are in. It names no one, because the tag in the link is
 * only verified after sign-in.
 */
export function ConnectPendingNotice() {
  const [pending] = useState(() => hasConnectStash())
  if (!pending) return null
  return (
    <Card padding={16} style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span
          className="zkm-type-card-title"
          style={{ color: "var(--text-primary)", fontFamily: "var(--font-display)" }}
        >
          Adding a contact
        </span>
        <span className="zkm-type-body-sm" style={{ color: "var(--text-secondary)" }}>
          Someone shared their zk.money tag with you. Create an account or log in, and you can add
          them next.
        </span>
      </div>
    </Card>
  )
}
