import { peekAuthService } from "../../platform/auth/useAuthenticator"
import { clearActiveStorage, clearCachedMsk } from "../../platform/storage/activeStorage"
import { clearWalletIdentity } from "./walletIdentity"

export type SignOutOptions = { keepPointers?: boolean }

/**
 * The destructive half of signing out, with no navigation. The in-memory key goes at once, with a
 * fence that keeps any cache from restoring it until the next commit; then the cached key, the
 * entered identity and the active-account pointers go. The removals are
 * synchronous localStorage writes, so one tab needs no lock. The passkey and the on-chain claim
 * survive. Callers that need a reload (logout, the chooser exit) navigate once it resolves. The
 * onboarding wizard signs out in place and keeps the pointers, because its pending registration
 * record lives under them and must stay reachable for the watcher; the cached key still goes.
 */
export async function signOut(options: SignOutOptions = {}): Promise<void> {
  peekAuthService()?.lockOut()
  // A store that refuses a removal throws; the async wrapper turns that into a rejected promise, so
  // callers that reload only on success (logout, the chooser exit) do not reload on a refusal.
  signOutNow(options)
}

/**
 * The store half alone. The browser-wide forget calls this after it has fenced the service itself
 * and inside its own lock; everyone else calls `signOut`.
 */
export function signOutNow(options: SignOutOptions = {}): void {
  clearWalletIdentity()
  clearCachedMsk()
  if (!options.keepPointers) {
    clearActiveStorage()
  }
}
