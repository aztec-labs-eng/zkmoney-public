import { useState } from "react"
import { reloadPage } from "../platform/storage/walletStorage"
import { clearConfigDraft, hasConfigDraft } from "./configDraft"

export function PreviewDraftRecovery() {
  const [error, setError] = useState<string>()
  if (!hasConfigDraft("profile") && !error) return null

  const clear = async () => {
    try {
      clearConfigDraft("profile")
      await reloadPage()
    } catch (cause) {
      // eslint-disable-next-line local/message-in-state -- debt
      setError((cause as Error).message)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void clear()}
        style={{ minHeight: 44, padding: "0 20px", fontSize: 16 }}
      >
        Use live config profile
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  )
}
