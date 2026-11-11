import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { semiDeviceBound } from "@obsidion/passkey-web"
import { memoryStore } from "@obsidion/front-core"
import type { BackupRecord } from "../../platform/auth/WebPasskeyIdentityMap"

/**
 * Whether a record's passkey lives on one device. A Proton Pass passkey counts
 * (`semiDeviceBound`); only a record this browser's creation wrote carries the provider id. A
 * record written before the flag was kept counts when the creation driver judged it a security
 * key; any other waits for its next prompt here.
 */
function deviceBound(record: BackupRecord): boolean {
  if (semiDeviceBound(record.prfAaguid)) return true
  if (record.backupEligible !== undefined) return !record.backupEligible
  return record.securityKey === true
}

/** Whether this browser last wrote the record's account with a second passkey. */
const hasBackup = (record: BackupRecord) =>
  record.backup !== undefined || (record.passkeySet?.length ?? 1) > 1

const DOLLAR = 10n ** BigInt(DEFAULT_DECIMALS)

/**
 * The balance threshold Main's balance has reached, atomic; undefined below the first. Home's
 * balance card shows at $100 and, once put off, again at each tenfold step. Only Main's last read
 * balance counts: not Savings, nor funds still arriving.
 */
export function balanceThreshold(main: bigint): bigint | undefined {
  let threshold = 100n * DOLLAR
  if (main < threshold) return undefined
  while (main >= threshold * 10n) threshold *= 10n
  return threshold
}

export type BackupNudgeFacts = {
  /** The session has the add: the build offers it, to an account. */
  enabled: boolean
  /** The session passkey's record. */
  record: BackupRecord | undefined
  /** A read of this device's saved backup adds found none; one in progress has its own lines. */
  noAddSaved: boolean
  /** The chain lists a second key, as after a backup added on a browser other than this one. */
  backupOnChain: boolean
}

/** A one-passkey account's nudge: its passkey lives on one device, or the account has one key. */
export type BackupNudge = "oneDevice" | "oneKey"

/** The Settings card and badges: every one-passkey account, until a backup exists. */
export function backupNudge(facts: BackupNudgeFacts): BackupNudge | undefined {
  const { enabled, record, noAddSaved, backupOnChain } = facts
  if (!enabled || backupOnChain || !noAddSaved || !record || hasBackup(record)) return undefined
  return deviceBound(record) ? "oneDevice" : "oneKey"
}

export type HomeNudgeFacts = BackupNudgeFacts & {
  /** Main's last read balance; undefined until it is known. */
  balance: bigint | undefined
  /** A withdrawal or Savings move under way, or not read yet, which the add waits for. */
  busy: boolean
  /** From the account's `BackupNudges`. */
  putOffAt: bigint | null | "unread"
  hiddenForSession: boolean
  /** A saved add waits on the user's last approval. */
  awaitsApproval: boolean
}

/** Home's card: finish a waiting add, a passkey on one device, or a balance threshold reached. */
export type HomeNudge =
  | { kind: "finish" }
  | { kind: "oneDevice" }
  | { kind: "oneKey"; threshold: bigint }

export function homeNudge(facts: HomeNudgeFacts): HomeNudge | undefined {
  if (facts.enabled && facts.awaitsApproval) return { kind: "finish" }
  const nudge = backupNudge(facts)
  const { balance, putOffAt } = facts
  if (!nudge || balance === undefined) return undefined
  // Once Main holds funds, every session.
  if (nudge === "oneDevice")
    return balance > 0n && !facts.hiddenForSession ? { kind: "oneDevice" } : undefined
  const threshold = balanceThreshold(balance)
  if (threshold === undefined || facts.busy || putOffAt === "unread") return undefined
  return putOffAt === null || threshold > putOffAt ? { kind: "oneKey", threshold } : undefined
}

/** The page's reminder state. */
export const pageBackupReminder = () => ({
  /**
   * Set when the Passkeys sheet reads more than one key on the account. Held for the page, which
   * serves one account; the next sign-in here writes the chain's key set to the record.
   */
  seenOnChain: memoryStore(false),
})

export type BackupReminder = ReturnType<typeof pageBackupReminder>
