import { currentInAppUpFront, type InAppUpFront } from "@obsidion/passkey-web"
import { hasOpeningBreadcrumb } from "../../platform/auth/WebPasskeyIdentityMap"
import { getActiveCredentialId } from "../../platform/storage/activeStorage"

/**
 * What an app's built-in browser is told before the wallet's first passkey prompt, unless a
 * passkey already worked in this browser: a record of a passkey that opens a wallet on the site,
 * or the credential the session was entered with. The address is not trusted.
 */
export function walletInAppUpFront(rpId: string): InAppUpFront | undefined {
  const mode = currentInAppUpFront()
  if (!mode || hasOpeningBreadcrumb(rpId) || getActiveCredentialId()) return undefined
  return mode
}
