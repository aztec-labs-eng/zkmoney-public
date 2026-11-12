import type { UnreadableRotationRow } from "@obsidion/front-core"
import { bestEffort, bestEffortSync } from "@obsidion/core/errors"
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
  currentUserAgentInfoSoon,
  isPasskeyCancelled,
  isPasskeyPolicyError,
  providerSlugFor,
  windowsReleaseFromHints,
} from "@obsidion/passkey-web"
import { fireEvent } from "./analytics"

/**
 * Backup passkey reporters: one `backup_passkey_add` per add attempt, one `backup_passkey_sign_in`
 * per sign-in with a backup passkey, and `backup_rotation_unreadable` when a saved rotation fails
 * its check. All go through the consent-gated `fireEvent`.
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
  // An error whose fields throw when read is still a failure.
  return bestEffortSync<Exclude<BackupPasskeyOutcome, "succeeded">>(() => {
    if (isPasskeyCancelled(error)) return "cancelled"
    if (isPasskeyPolicyError(error)) return "refused"
    return "failed"
  }, "failed")
}

/** The id rides only for an `other` provider whose id is itself unlisted, lowercased. */
function otherAaguid(facts: BackupPasskeyFacts | undefined): string | undefined {
  const aaguid = facts?.aaguid?.toLowerCase()
  return facts?.provider === "other" && providerSlugFor(aaguid) === "other" ? aaguid : undefined
}

function reportBackupPasskeyAdd(
  outcome: BackupPasskeyOutcome,
  facts: BackupPasskeyFacts | undefined,
  windowsRelease: "10" | "11" | undefined,
  error?: unknown,
): void {
  // Telemetry never fails the add.
  bestEffortSync(
    () =>
      fireEvent("backup_passkey_add", {
        outcome,
        provider: facts?.provider ?? "unknown",
        device_bound: facts?.deviceBound,
        prf_at_create: facts?.prfAtCreate,
        reason: error instanceof BackupPasskeyRefusedError ? error.kind : undefined,
        aaguid: otherAaguid(facts),
        windows_release: windowsRelease,
      }),
    undefined,
  )
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
  // Read beside the ceremony, so the prompt still opens on the tap. Windows Hello's key material
  // depends on the release; the event keeps the release only, never the build.
  const windowsRelease = bestEffort(
    "unknown",
    currentUserAgentInfoSoon().then(windowsReleaseFromHints),
  )
  const ceremony = backupPasskeyCeremony((evidence) => {
    saved = evidence
  })
  const observe: CeremonyObserver = (event) => {
    if (event.phase !== "created") return
    // Unreadable facts leave the add with what the browser said, if anything.
    facts = bestEffortSync(() => backupCreationFacts(event.result), facts)
  }
  let result: T
  try {
    result = await run(ceremony, observe)
  } catch (error) {
    const known = facts ?? (saved && backupAnswerFacts(saved))
    reportBackupPasskeyAdd(backupPasskeyOutcomeFor(error), known, await windowsRelease, error)
    throw error
  }
  reportBackupPasskeyAdd("succeeded", facts, await windowsRelease)
  return result
}

/** One call per sign-in whose answering key is a backup passkey, once its outcome is known. */
export function reportBackupPasskeySignIn(
  outcome: BackupPasskeyOutcome,
  facts: BackupPasskeyFacts = { provider: "unknown" },
): void {
  // Telemetry never fails a sign-in.
  bestEffortSync(
    () =>
      fireEvent("backup_passkey_sign_in", {
        outcome,
        provider: facts.provider,
        device_bound: facts.deviceBound,
        aaguid: otherAaguid(facts),
      }),
    undefined,
  )
}

export function reportBackupRotationUnreadable(row: UnreadableRotationRow): void {
  fireEvent("backup_rotation_unreadable", {
    phase: row.phase,
    outcome: row.outcome,
    unswept: row.unswept,
  })
}
