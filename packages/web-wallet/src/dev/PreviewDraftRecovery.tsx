import { useState } from "react"
import { reloadPage } from "../platform/storage/walletStorage"
import { clearProfileDraft, hasProfileDraft } from "./configDraft"

export function PreviewDraftRecovery() {
  const [error, setError] = useState<string>()
  if (!hasProfileDraft() && !error) return null

  const clear = async () => {
    try {
      clearProfileDraft()
      await reloadPage()
    } catch (cause) {
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
