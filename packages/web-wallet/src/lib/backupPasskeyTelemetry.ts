import {
  BackupPasskeyRefusedError,
  type BackupPasskeyFacts,
  BrowserPasskeyCeremony,
  type CeremonyObserver,
  DEFAULT_CEREMONY_TIMING,
  type PasskeyAnswerEvidence,
  type PasskeyCeremony,
  type PasskeyRequestHook,
  backupAnswerFacts,
  backupCreationFacts,
  isPasskeyCancelled,
  isPasskeyPolicyError,
  providerSlugFor,
} from "@obsidion/passkey-web"
import { fireEvent } from "./analytics"

/**
 * Backup passkey reporters: one `backup_passkey_add` per add attempt, one `backup_passkey_sign_in`
 * per sign-in with a backup passkey. Both go through the consent-gated `fireEvent`.
 */

export const BACKUP_PASSKEY_OUTCOMES = ["succeeded", "cancelled", "refused", "failed"] as const
export type BackupPasskeyOutcome = (typeof BACKUP_PASSKEY_OUTCOMES)[number]

/**
 * The ceremony one backup add runs on. It has no passkey tracker, so an add never writes a
 * `passkey_ceremony` row, never joins an open attempt, and never takes the signup channel. Its
 * request hook hands over what the browser said about a passkey it saved, read before the
 * response is decoded, so an add that fails on the decode still names the provider. Its requests
 * reach a Proton Pass wrapper the page's lock kept aside, where one exists.
 */
function backupPasskeyCeremony(saved: (evidence: PasskeyAnswerEvidence) => void): PasskeyCeremony {
  const hook: PasskeyRequestHook = (signal) => {
    if (signal.phase === "answered" && signal.kind === "create") saved(signal.evidence)
  }
  return new BrowserPasskeyCeremony(DEFAULT_CEREMONY_TIMING, hook)
}

export function backupPasskeyOutcomeFor(
  error: unknown,
): Exclude<BackupPasskeyOutcome, "succeeded"> {
  try {
    if (isPasskeyCancelled(error)) return "cancelled"
    if (isPasskeyPolicyError(error)) return "refused"
  } catch {
    // An error whose fields throw when read is still a failure.
  }
  return "failed"
}

/** The id rides only for an `other` provider whose id is itself unlisted, lowercased. */
function otherAaguid(facts: BackupPasskeyFacts | undefined): string | undefined {
  const aaguid = facts?.aaguid?.toLowerCase()
  return facts?.provider === "other" && providerSlugFor(aaguid) === "other" ? aaguid : undefined
}

function reportBackupPasskeyAdd(
  outcome: BackupPasskeyOutcome,
  facts: BackupPasskeyFacts | undefined,
  error?: unknown,
): void {
  try {
    fireEvent("backup_passkey_add", {
      outcome,
      provider: facts?.provider ?? "unknown",
      device_bound: facts?.deviceBound,
      prf_at_create: facts?.prfAtCreate,
      reason: error instanceof BackupPasskeyRefusedError ? error.kind : undefined,
      aaguid: otherAaguid(facts),
    })
  } catch {
    // Telemetry never fails the add.
  }
}

/**
 * Runs one backup add attempt and reports it once, when `run` settles: `succeeded` when it
 * resolves, else what its error maps to. `run` gets the ceremony to run on and the observer to
 * pass to `runBackupPasskeyCreation`, so a refusal, a dismissed second prompt or a saved passkey
 * whose response failed to decode still names the passkey.
 */
export async function trackBackupPasskeyAdd<T>(
  run: (ceremony: PasskeyCeremony, observe: CeremonyObserver) => Promise<T>,
): Promise<T> {
  let saved: PasskeyAnswerEvidence | undefined
  let facts: BackupPasskeyFacts | undefined
  const ceremony = backupPasskeyCeremony((evidence) => {
    saved = evidence
  })
  const observe: CeremonyObserver = (event) => {
    if (event.phase !== "created") return
    try {
      facts = backupCreationFacts(event.result)
    } catch {
      // The add reports with what the browser said, if anything.
    }
  }
  let result: T
  try {
    result = await run(ceremony, observe)
  } catch (error) {
    const known = facts ?? (saved && backupAnswerFacts(saved))
    reportBackupPasskeyAdd(backupPasskeyOutcomeFor(error), known, error)
    throw error
  }
  reportBackupPasskeyAdd("succeeded", facts)
  return result
}

/** One call per sign-in whose answering key is a backup passkey, once its outcome is known. */
export function reportBackupPasskeySignIn(
  outcome: BackupPasskeyOutcome,
  facts: BackupPasskeyFacts = { provider: "unknown" },
): void {
  try {
    fireEvent("backup_passkey_sign_in", {
      outcome,
      provider: facts.provider,
      device_bound: facts.deviceBound,
      aaguid: otherAaguid(facts),
    })
  } catch {
    // Telemetry never fails a sign-in.
  }
}
