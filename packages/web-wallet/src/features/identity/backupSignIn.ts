import { backupSignInFacts } from "@obsidion/passkey-web"
import { reportBackupPasskeySignIn } from "../../lib/backupPasskeyTelemetry"

/**
 * The backup sign-in event: one per sign-in a backup passkey answered, once its outcome is known.
 * The facts are what the event may learn about the passkey, never the PRF output, the envelope or
 * the assertion.
 */
export type BackupSignInOutcome = "succeeded" | "failed" | "cancelled" | "refused"

export interface BackupSignInFacts {
  /** Whether the answering passkey can be backed up, once an assertion answered. */
  backupEligible?: boolean
  /** The provider this browser's record names for the passkey, when it holds one. */
  aaguid?: string
  /** Set once the sign-in reported its end. One facts object stands for one sign-in. */
  ended?: true
}

/** The sign-in's first end is the one it reports. */
export function noteBackupSignIn(outcome: BackupSignInOutcome, facts: BackupSignInFacts): void {
  if (facts.ended) return
  facts.ended = true
  reportBackupPasskeySignIn(
    outcome,
    backupSignInFacts({ backupEligible: facts.backupEligible }, { aaguid: facts.aaguid }),
  )
}
