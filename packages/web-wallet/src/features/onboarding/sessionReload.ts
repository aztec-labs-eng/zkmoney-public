import { reloadPage } from "../../platform/storage/walletStorage"
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
    markOnboardingResume()
    void reloadPage()
    return true
  }
  return false
}

const ONBOARDING_RESUME_KEY = "webwallet.onboarding.resumed"

/**
 * Stamp that the reload above is a hand-off resume, so the reloaded wizard waits on the work it
 * already started before the switch.
 */
function markOnboardingResume(): void {
  try {
    sessionStorage.setItem(ONBOARDING_RESUME_KEY, "1")
  } catch {
    // Without it the reloaded wizard starts the hand-off afresh: slower, not broken.
  }
}

/** True once for the wizard a session-switch reload landed on; the mark is spent on read. */
export function takeOnboardingResume(): boolean {
  try {
    if (sessionStorage.getItem(ONBOARDING_RESUME_KEY) !== "1") return false
    sessionStorage.removeItem(ONBOARDING_RESUME_KEY)
    return true
  } catch {
    return false
  }
}
