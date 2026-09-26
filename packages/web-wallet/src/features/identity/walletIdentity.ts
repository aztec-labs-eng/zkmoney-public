import { getConfig } from "../../config/env"
import { getActiveCredentialId } from "../../platform/storage/activeStorage"
import { hasMskRootBreadcrumb, rememberUsertag } from "../../platform/auth/WebPasskeyIdentityMap"
import { clearAdmission } from "./admission"

export type WalletIdentity = {
  /** Absent until a name is registered: the wallet runs nameless and tag surfaces prompt for one. */
  handle?: string
  address: string
  claimedAt: number
  /** The L1 registration is not yet confirmed — tag surfaces render claiming-in-progress. */
  pending?: boolean
}

const STORAGE_KEY = "webwallet.identity"

/**
 * Device-local record of the entered account — its L2 address plus the claimed
 * @tag once one exists. Its presence is what gates the wallet routes; absence
 * sends the visitor to /claim. Clearing it means re-onboarding (or, later,
 * returning-user entry via /enter).
 */
export function loadWalletIdentity(): WalletIdentity | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as WalletIdentity
    if (typeof parsed.address !== "string") return null
    if (parsed.handle !== undefined && typeof parsed.handle !== "string") return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Resolves once the passkey hint is written too; a caller about to leave the page awaits it.
 * Settled tags only: a pending claim can still lose the name race, and a nameless save must not
 * disturb a hint from an earlier claim. The session's passkey carries the tag through logout
 * and account switching, which clear this record. `stillOwns` reaches the hint's write: a sign-in
 * that ended while the map lock was held leaves it unwritten.
 */
export function saveWalletIdentity(
  identity: WalletIdentity,
  stillOwns?: () => boolean,
): Promise<void> {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity))
  const credentialId = getActiveCredentialId()
  if (identity.pending || !identity.handle || !credentialId) return Promise.resolve()
  return rememberUsertag(getConfig().rpId, credentialId, identity.handle, stillOwns).catch(() => {})
}

export function clearWalletIdentity(): void {
  localStorage.removeItem(STORAGE_KEY)
  // The cached grant was proved for this identity; a successor proves its own.
  clearAdmission()
}

/** L1 confirmed: drop the pending marker so tag surfaces render settled ownership. */
export function confirmWalletIdentity(): void {
  const identity = loadWalletIdentity()
  if (!identity?.pending) return
  const { pending: _pending, ...settled } = identity
  void saveWalletIdentity(settled)
}

/** The name race was lost: a pending identity must never be presented as owned. */
export function retractPendingWalletIdentity(): void {
  if (loadWalletIdentity()?.pending) clearWalletIdentity()
}

/**
 * The wallet-route gate: entering the wallet needs BOTH the passkey breadcrumb
 * (created before entry) and the identity record — nameless is fine, the
 * record marks a completed entry while a missing one means onboarding died
 * before completion. An identity without the passkey breadcrumb is a stale
 * record (the account key is gone): treated as not onboarded. A passkey
 * deleted at the AUTHENTICATOR leaves both records intact and is locally
 * undetectable — that case surfaces as an assertion failure and belongs to the
 * /enter recovery slice.
 */
export function loadOnboardedIdentity(): WalletIdentity | null {
  if (!hasMskRootBreadcrumb(getConfig().rpId)) return null
  return loadWalletIdentity()
}
