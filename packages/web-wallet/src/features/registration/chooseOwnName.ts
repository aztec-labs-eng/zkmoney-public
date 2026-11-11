import {
  depositOwed,
  type PendingRegistrationRecord,
  type RegistrationRoute,
} from "@obsidion/front-core"
import { base64UrlToBytes, renamePasskey } from "@obsidion/passkey-web"
import { WalletError, bestEffort } from "@obsidion/core/errors"
import type { ObsidionAccount, ObsidionWallet } from "@obsidion/sdk"
import { rememberUsertag, userHandleFor } from "../../platform/auth/WebPasskeyIdentityMap"
import { collectOnboardingKeys, saveIdentity, type OnboardingKeys } from "../../session/account"
import type { Session } from "../../session/session"
import {
  openRegistration,
  registrationTagConfirmed,
  type RegistrationReads,
} from "./openRegistration"
import { hasCustody } from "./webRegistration"

/** Claims `tag` over `replaced`, at a new address. */
export type ClaimOver = (
  tag: string,
  keys: OnboardingKeys,
  replaced: PendingRegistrationRecord,
) => Promise<unknown>

/** Builds the session's claim on a chosen name; onboarding supplies it. */
export type ChosenNameClaim = (
  session: Session,
  wallet: ObsidionWallet,
  earned: boolean,
  route: RegistrationRoute,
) => ClaimOver

/** Replaces the registration still owed its deposit with a claim on `tag`, at a new address. */
export async function chooseOwnName(
  session: RegistrationReads & Pick<Session, "database" | "device" | "identity" | "auth" | "page">,
  tag: string,
  account: ObsidionAccount,
  claim: ClaimOver,
): Promise<void> {
  // Read once the withdrawals load: a ticket's burn may already fund this address.
  const burns = await session.withdrawals.all()
  const open = openRegistration(session, burns)
  const identity = session.identity.get().value
  if (
    !open?.stage ||
    !identity ||
    open.record.phase !== "awaiting_deposit" ||
    !depositOwed(open.stage) ||
    hasCustody(open.record)
  ) {
    throw new WalletError("registration.nameLocked")
  }
  if (registrationTagConfirmed(session, open.record, burns)) {
    throw new WalletError("registration.nameConfirmed")
  }
  const keys = await collectOnboardingKeys(session, account)
  await claim(tag, keys, open.record)
  await saveIdentity(session.page, { ...identity, handle: tag, pending: true })
  console.info("[passkey] renaming the passkey to", tag)
  const { credentialId, passkeyMap } = session.device.get()
  if (!credentialId) {
    console.warn("[passkey] rename skipped: no active credential")
    return
  }
  const { rpId } = session.page.config
  const userHandle = userHandleFor(passkeyMap, rpId, credentialId)
  if (userHandle) renamePasskey(rpId, base64UrlToBytes(userHandle), tag)
  else console.warn("[passkey] rename skipped: no user handle stored for this passkey")
  await bestEffort("unknown", rememberUsertag(session.database, rpId, credentialId, tag))
}
