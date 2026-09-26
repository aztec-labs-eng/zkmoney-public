import { useRef, useState, type CSSProperties, type ReactNode } from "react"
import { clearSiteData, type Leftover } from "../platform/storage/clearSiteData"

export const RESET_PATH = "/reset"

// Self-styled: the design-system CSS loads with the wallet chunk, after the wallet's own styles.
const page: CSSProperties = {
  minHeight: "100dvh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
  boxSizing: "border-box",
  background: "#0b0b10",
  color: "#fff",
  fontFamily: "system-ui, -apple-system, sans-serif",
}
const card: CSSProperties = {
  maxWidth: 420,
  display: "flex",
  flexDirection: "column",
  gap: 16,
  textAlign: "center",
}
const title: CSSProperties = { margin: 0, fontSize: 24, fontWeight: 700 }
const body: CSSProperties = { margin: 0, color: "rgba(255, 255, 255, 0.7)", lineHeight: 1.5 }
const list: CSSProperties = { ...body, padding: 0, listStyle: "none" }
const actions: CSSProperties = { display: "flex", gap: 12, justifyContent: "center" }

const KIND_LABEL: Record<Leftover["kind"], string> = {
  files: "Wallet files",
  databases: "Browser databases",
  localStorage: "Sign-in and settings",
  sessionStorage: "This tab's data",
}
const REASON_LABEL: Record<Leftover["reason"], string> = {
  busy: "in use by another tab",
  pending: "will be removed when other tabs close",
  unavailable: "blocked by this browser",
}
const buttonBase: CSSProperties = {
  flex: 1,
  minHeight: 48,
  padding: "0 20px",
  border: "1px solid rgba(255, 255, 255, 0.2)",
  borderRadius: 999,
  color: "#fff",
  font: "inherit",
  fontWeight: 600,
  cursor: "pointer",
}
const spinnerCss =
  "@keyframes ww-reset-spin{to{transform:rotate(360deg)}}" +
  ".ww-reset-spinner{display:inline-block;width:16px;height:16px;margin-right:8px;vertical-align:-3px;" +
  "border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;" +
  "animation:ww-reset-spin .8s linear infinite}"

function Button({
  children,
  danger,
  busy,
  onClick,
}: {
  children: ReactNode
  danger?: boolean
  busy?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={busy}
      aria-busy={busy}
      onClick={onClick}
      style={{ ...buttonBase, background: danger ? "#d6334c" : "rgba(255, 255, 255, 0.08)" }}
    >
      {busy && <span className="ww-reset-spinner" aria-hidden />}
      {children}
    </button>
  )
}

const leave = () => location.replace("/")

/**
 * The last-resort reset: deletes this browser's wallet data, then reloads. It renders before the
 * wallet boots so none of the wallet's files are open in this tab, and so it works when the wallet
 * itself won't start. Opening the link alone never deletes anything.
 */
export function ResetScreen({ clear = clearSiteData }: { clear?: () => Promise<Leftover[]> }) {
  const [clearing, setClearing] = useState(false)
  const [left, setLeft] = useState<Leftover[]>()
  const attempt = useRef<Promise<Leftover[]>>(undefined)

  const start = () => {
    if (attempt.current) return
    setClearing(true)
    attempt.current = clear()
    void attempt.current.then((result) => {
      attempt.current = undefined
      if (result.length === 0) return leave()
      setClearing(false)
      setLeft(result)
    })
  }

  return (
    <main style={page}>
      <style>{spinnerCss}</style>
      {left ? (
        <div style={card}>
          <h1 style={title}>Some data couldn't be cleared</h1>
          <ul style={list}>
            {[...new Set(left.map((l) => `${KIND_LABEL[l.kind]}: ${REASON_LABEL[l.reason]}`))].map(
              (line) => (
                <li key={line}>{line}</li>
              ),
            )}
          </ul>
          {left.some((l) => l.reason !== "unavailable") && (
            <p style={body}>Close other zk.money tabs and windows, then try again.</p>
          )}
          <div style={actions}>
            {!clearing && <Button onClick={leave}>Continue</Button>}
            <Button danger busy={clearing} onClick={start}>
              Try again
            </Button>
          </div>
        </div>
      ) : (
        <div style={card}>
          <h1 style={title}>Clear this browser's wallet data?</h1>
          <p style={body}>
            This signs every account out of zk.money on this browser and deletes its local data:
            contacts, activity, and anything still pending, like a tag registration or a deposit.
            Some of it may not come back. Your passkey and everything on chain stay as they are.
          </p>
          <p style={body}>Close any other zk.money tabs or windows first.</p>
          <div style={actions}>
            {!clearing && <Button onClick={leave}>Cancel</Button>}
            <Button danger busy={clearing} onClick={start}>
              Clear data
            </Button>
          </div>
        </div>
      )}
    </main>
  )
}
