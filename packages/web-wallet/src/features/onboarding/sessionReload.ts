import { getAuthService } from "../../platform/auth/useAuthenticator"
import { getActiveStorageId } from "../../platform/storage/activeStorage"
import { clearWalletIdentity, loadWalletIdentity } from "../identity/walletIdentity"

/**
 * Account stores load once per page. A recovery that committed another account than the one this
 * page loaded must replace the document before anything is written, or the first write carries that
 * account's records into the new one's storage. The committed session opens the reloaded page from
 * its cached key. An entered identity that is not the committed account's goes first.
 */
export function reloadIfSessionSwitched(
  previousStorageId: string | null,
  l2Address: string,
): boolean {
  const identity = loadWalletIdentity()
  if (identity && identity.address.toLowerCase() !== l2Address.toLowerCase()) clearWalletIdentity()
  if (
    getAuthService()?.recordsStale?.() ||
    (previousStorageId !== null && previousStorageId !== getActiveStorageId())
  ) {
    window.location.reload()
    return true
  }
  return false
}
