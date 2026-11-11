import { Icon } from "@obsidion/web-ds"
import { reloadPage } from "../../../platform/storage/walletStorage"
import copy from "./RequestsUnavailableNotice.copy"

/**
 * Requests sent to the user are hidden because the contacts could not be read. Nothing reads them
 * again before a reload.
 */
export function RequestsUnavailableNotice({ reload = () => void reloadPage() }) {
  return (
    <p className="ww-requests-unavailable" role="status" data-testid="requests-unavailable">
      <Icon name="information-line" size={16} />
      {copy.unavailable}{" "}
      <button type="button" className="zkm-btn-reset ww-deposit__link" onClick={reload}>
        {copy.tryAgain}
      </button>
    </p>
  )
}
