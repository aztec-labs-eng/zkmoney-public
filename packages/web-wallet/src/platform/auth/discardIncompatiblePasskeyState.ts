import { clearWalletIdentity } from "../../features/identity/walletIdentity"
import { WebStorageAdapter } from "../storage/WebStorageAdapter"
import {
  clearActiveStorage,
  clearCachedMsk,
  getActiveCredentialId,
  getActiveStorageId,
  readCachedMsk,
} from "../storage/activeStorage"
import { walletStorage } from "../storage/walletStorage"
import { WebPasskeyIdentityMap } from "./WebPasskeyIdentityMap"

/**
 * Writes the session, so only the active tab runs it: once it has opened its databases, before
 * account consumers mount, including when there is no cached key.
 */
export async function discardIncompatiblePasskeyState(rpId: string): Promise<void> {
  const identities = new WebPasskeyIdentityMap(new WebStorageAdapter(), rpId)
  const credentialId = getActiveCredentialId()
  const record = credentialId ? await identities.get(credentialId) : undefined
  if (!record || !getActiveStorageId()) {
    await walletStorage.batch(() => {
      clearActiveStorage()
      clearWalletIdentity()
    })
  } else {
    const cache = readCachedMsk()
    if (
      cache &&
      (cache.credentialId !== credentialId || cache.storageId !== getActiveStorageId())
    ) {
      await walletStorage.batch(() => clearCachedMsk())
    }
  }
  await identities.discardOtherRps()
}
