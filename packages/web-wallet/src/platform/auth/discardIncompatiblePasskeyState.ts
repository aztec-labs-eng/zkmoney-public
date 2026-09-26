import { clearWalletIdentity } from "../../features/identity/walletIdentity"
import { WebStorageAdapter } from "../storage/WebStorageAdapter"
import {
  clearActiveStorage,
  clearCachedMsk,
  getActiveCredentialId,
  getActiveStorageId,
  readCachedMsk,
  withSessionLock,
} from "../storage/activeStorage"
import { sweepExpiredHandoffMaterial } from "../storage/handoffMaterial"
import { WebPasskeyIdentityMap } from "./WebPasskeyIdentityMap"

/** Run before mounting account consumers, including when there is no cached key. */
export async function discardIncompatiblePasskeyState(rpId: string): Promise<void> {
  const identities = new WebPasskeyIdentityMap(new WebStorageAdapter(), rpId)
  await withSessionLock(async () => {
    const credentialId = getActiveCredentialId()
    const record = credentialId ? await identities.get(credentialId) : undefined
    if (!record || !getActiveStorageId()) {
      clearActiveStorage()
      clearWalletIdentity()
    } else {
      const cache = readCachedMsk()
      if (cache && (cache.credentialId !== credentialId || cache.storageId !== getActiveStorageId())) {
        clearCachedMsk()
      }
    }
    await identities.discardOtherRps()
  })
  await sweepExpiredHandoffMaterial(Date.now(), rpId)
}
