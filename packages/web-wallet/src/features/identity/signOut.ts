import { peekAuthService } from "../../platform/auth/useAuthenticator"
import {
  clearActiveStorage,
  clearCachedMsk,
  clearSessionEverywhere,
  withSessionLock,
} from "../../platform/storage/activeStorage"
import { walletStorage } from "../../platform/storage/walletStorage"
import { clearWalletIdentity } from "./walletIdentity"

export type SignOutOptions = {
  keepPointers?: boolean
  /** Leave other rollups' sessions alone: for a sign-out the user did not ask for. */
  localOnly?: boolean
}

/**
 * The destructive half of signing out, with no navigation. The in-memory key goes at once, with a
 * fence that keeps any cache from restoring it until the next commit. Then, under the session lock a
 * sign-in's commit also takes, the session tuple leaves every other rollup's database and any copy
 * an older build left in `localStorage`, and this rollup's identity, cached key and pointers go as
 * one transaction. It resolves once everything is saved, so callers that navigate await it. The passkey
 * and the on-chain claim survive. The onboarding wizard keeps the pointers, because its pending
 * registration record lives under them.
 */
export async function signOut(options: SignOutOptions = {}): Promise<void> {
  peekAuthService()?.lockOut()
  await withSessionLock(async () => {
    if (!options.localOnly) await clearSessionEverywhere()
    await walletStorage.batch(() => {
      clearWalletIdentity()
      clearCachedMsk()
      if (!options.keepPointers) clearActiveStorage()
    })
  })
}
