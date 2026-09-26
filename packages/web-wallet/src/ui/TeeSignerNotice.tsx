import { useAssetContext } from "@obsidion/front-core"
import { TeeSignerNotApprovedError } from "@obsidion/sdk"
import { Icon } from "@obsidion/web-ds"
import "./teeSignerNotice.css"

/** The connect-time refusal the wallet is retrying past, or null when the signer is fine or failing for another reason. */
export function useTeeSignerRefusal(): TeeSignerNotApprovedError | null {
  const { teeSignerError } = useAssetContext()
  return teeSignerError instanceof TeeSignerNotApprovedError ? teeSignerError : null
}

/**
 * Inline notice for the send, paylink and withdraw flows while the fleet keeps handing out an
 * enclave the token has not approved. Informational only: the flow stays open and the connect
 * retries on its own, so nothing here blocks or dismisses.
 */
export function TeeSignerNotice() {
  const refusal = useTeeSignerRefusal()
  if (!refusal) return null
  return (
    <div className="ww-tee-notice" role="status">
      <Icon name="alert-circle" size={18} color="var(--accent-gold)" />
      <span className="ww-tee-notice__text">
        Payments are unavailable for the moment: the signing enclave this wallet reached is not
        approved yet. The wallet is retrying automatically.
      </span>
    </div>
  )
}
