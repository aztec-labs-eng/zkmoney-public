import { useEffect, useState } from "react"
import { relayGoogleCallback } from "./googleRelay"

/** Runs inside the popup once Google redirects back to our origin, and hands the result over. */
export function GoogleCallbackScreen() {
  const [message, setMessage] = useState("Finishing sign-in…")

  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (!relayGoogleCallback(window.location.hash)) {
      setMessage("Sign-in state is missing — close this window and try again.")
      return
    }
    window.close()
    setMessage("Sign-in complete — you can close this window.")
  }, [])

  return (
    <div style={{ padding: 24, textAlign: "center", color: "var(--text-secondary)" }}>
      {message}
    </div>
  )
}
