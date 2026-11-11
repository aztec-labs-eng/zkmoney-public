import { fmt } from "../../../lib/fmt"
import copy from "./WalletPromptNote.copy"

/** The stall note under a sheet's wallet stage, with the way back to its form. */
export function WalletPromptNote({
  walletName,
  onCancel,
}: {
  walletName?: string | null
  onCancel?: () => void
}) {
  return (
    <p className="ww-sheet__note" role="status" data-testid="wallet-prompt-stall">
      {fmt(copy.stalled, { wallet: walletName ?? copy.yourWallet })}
      {onCancel && (
        <>
          {" "}
          <button type="button" className="zkm-btn-reset ww-deposit__link" onClick={onCancel}>
            {copy.cancel}
          </button>
        </>
      )}
    </p>
  )
}
