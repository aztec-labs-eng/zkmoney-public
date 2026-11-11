import type { Fr } from "@aztec-labs/aztec.js/fields"
import { stageIdentity, type IdentityView, type WalletIdentity } from "@obsidion/front-core"
import type { AlphaAuthProvider, ObsidionAccount } from "@obsidion/sdk"
import { WalletError, bestEffort } from "@obsidion/core/errors"
import { SessionChangedError } from "../platform/auth/sessionErrors"
import { hasOpeningBreadcrumb, rememberUsertag } from "../platform/auth/WebPasskeyIdentityMap"
import { activeNamespace, type Session } from "./session"

/** Where the page's identity writes go: the committed account's namespace. */
type IdentityPage = Pick<Session["page"], "database" | "device" | "config">

/**
 * Saves the committed account's identity, whose session may not be open yet, then the passkey
 * hint; a caller about to enter the wallet or leave the page awaits it. It rejects when the
 * identity could not be saved, and saves none once a sign-out left no committed account. Settled
 * tags only reach the hint: a pending claim can still lose the name race, and a nameless save must
 * not disturb a hint from an earlier claim. `stillOwns` reaches the hint's write: a sign-in that
 * ended while the map write waited leaves it unwritten.
 */
export async function saveIdentity(
  page: IdentityPage,
  identity: WalletIdentity,
  stillOwns?: () => boolean,
): Promise<void> {
  const { database, device, config } = page
  await database.write(async (w) => {
    const committed = activeNamespace(device)
    if (committed.id !== null) stageIdentity(w, committed.prefix, identity)
  })
  const { credentialId } = device.get()
  const handle = identity.handle
  if (identity.pending || !handle || !credentialId) return
  await bestEffort(
    "unknown",
    rememberUsertag(database, config.rpId, credentialId, handle, stillOwns),
  )
}

/**
 * The wallet-route gate: entering the wallet needs BOTH the passkey breadcrumb (created before
 * entry) and the identity record. Nameless is fine: the record marks a completed entry, while a
 * missing one means onboarding died before completion. An identity without the breadcrumb is a
 * stale record (the account key is gone), so not onboarded. A passkey deleted at the AUTHENTICATOR
 * leaves both intact and is locally undetectable: it surfaces as an assertion failure on /enter.
 * Undefined while the identity is unloaded or cannot be read: unknown, never onboarding.
 */
export function enteredIdentity(
  identity: IdentityView,
  passkeyMap: string | null,
  rpId: string,
): WalletIdentity | null | undefined {
  if (!hasOpeningBreadcrumb(passkeyMap, rpId)) return null
  return identity.loaded && !identity.failed ? identity.value : undefined
}

/**
 * Key material the L1 claim + FPC subscribe steps need, gathered after
 * `createAccount` (or a recovery flow in `oxideOnboarding`) has committed the MSK.
 */
export interface OnboardingKeys {
  account: ObsidionAccount
  secretKey: Fr
  authProvider: AlphaAuthProvider
  /** 0x-prefixed 64-byte (x‖y) passkey R1 pubkey. */
  pubkeyHex: string
}

export function pubkeyHexFrom(x: Buffer, y: Buffer): string {
  return `0x${Buffer.concat([x, y]).toString("hex")}`
}

/**
 * Gather the key material the claim + FPC steps need. Call right after
 * `createAccount`, which drove the session's auth service, so the MSK / auth provider are already
 * committed. The pair is the session's, so the account
 * must be too: one built for a session since replaced is refused as `SessionChangedError`.
 */
export async function collectOnboardingKeys(
  session: { auth: Pick<Session["auth"], "sessionKeys"> },
  account: ObsidionAccount,
): Promise<OnboardingKeys> {
  const keys = await session.auth.sessionKeys()
  if (!keys) throw new WalletError("account.locked", "no session keys to continue onboarding")
  if (account.getAuthProvider() !== keys.authProvider) throw new SessionChangedError()
  const { secretKey, authProvider } = keys
  const [x, y] = await authProvider.getPubkeys()
  return { account, secretKey, authProvider, pubkeyHex: pubkeyHexFrom(x, y) }
}
