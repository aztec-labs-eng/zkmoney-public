import { useAssetContext } from "@obsidion/front-core"
import { TeeSignerNotApprovedError } from "@obsidion/sdk"
import { Warning } from "./Warning"

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
    <Warning title="Payments are unavailable for the moment">
      The signing enclave this wallet reached is not approved yet. The wallet is retrying
      automatically.
    </Warning>
  )
}
