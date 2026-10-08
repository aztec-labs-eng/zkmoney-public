import { currentInAppUpFront, type InAppUpFront } from "@obsidion/passkey-web"
import { hasMskRootBreadcrumb } from "../../platform/auth/WebPasskeyIdentityMap"
import { getActiveCredentialId } from "../../platform/storage/activeStorage"

/**
 * What an app's built-in browser is told before the wallet's first passkey prompt, unless a
 * passkey already worked in this browser: a root passkey record for the site, or the credential
 * the session was entered with. The address is not trusted.
 */
export function walletInAppUpFront(rpId: string): InAppUpFront | undefined {
  const mode = currentInAppUpFront()
  if (!mode || hasMskRootBreadcrumb(rpId) || getActiveCredentialId()) return undefined
  return mode
}
