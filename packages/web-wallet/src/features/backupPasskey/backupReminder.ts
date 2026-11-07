import { createExternalState } from "../../lib/externalState"
import type { BackupRecord } from "../../platform/auth/WebPasskeyIdentityMap"

/**
 * Whether a record's passkey lives on one device. A record written before the flag was kept counts
 * when the creation driver judged it a security key; any other waits for its next prompt here.
 */
function deviceBound(record: BackupRecord): boolean {
  if (record.backupEligible !== undefined) return !record.backupEligible
  return record.securityKey === true
}

/** Whether this browser last wrote the record's account with a second passkey. */
const hasBackup = (record: BackupRecord) =>
  record.backup !== undefined || (record.passkeySet?.length ?? 1) > 1

export type BackupReminderFacts = {
  /** The build offers the backup add. */
  enabled: boolean
  /** The session passkey's record. */
  record: BackupRecord | undefined
  /** A read of this device's saved backup adds found none; one in progress has its own lines. */
  noAddSaved: boolean
  /** The chain lists a second key, as after a backup added on a browser other than this one. */
  backupOnChain: boolean
  dismissed: boolean
}

/** Whether Home reminds a one-device account to add a backup passkey. */
export function backupReminderApplies(facts: BackupReminderFacts): boolean {
  const { enabled, record, noAddSaved, backupOnChain, dismissed } = facts
  if (!enabled || dismissed || backupOnChain || !noAddSaved || !record) return false
  return deviceBound(record) && !hasBackup(record)
}

/** "Not now" hides the reminder until the page loads again, the next session. */
export const backupReminderDismissed = createExternalState(false)

/**
 * Set when the Passkeys sheet reads more than one key on the account. Held for the page, which
 * serves one account; the next sign-in here writes the chain's key set to the record.
 */
export const backupSeenOnChain = createExternalState(false)
