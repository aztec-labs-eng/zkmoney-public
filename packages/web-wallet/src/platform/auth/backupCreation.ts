import type {
  BackupPasskeyCreation,
  CeremonyObserver,
  PasskeyCeremony,
  runBackupPasskeyCreation,
} from "@obsidion/passkey-web"

/** A created backup passkey with the PRF output the master key is sealed under. */
export type BackupCreation = BackupPasskeyCreation

/**
 * Creates a backup passkey on `ceremony` and reads its PRF, or refuses it with the credential
 * forgotten: `runBackupPasskeyCreation` in production, a fake in tests.
 */
export type BackupCreationDriver = typeof runBackupPasskeyCreation

/**
 * Runs one add attempt and reports it once it settles. It hands `run` the ceremony to create on
 * and the observer to pass to the driver, so a refusal or a passkey whose response failed to
 * decode is still described.
 */
export type BackupAddTracker = <T>(
  run: (ceremony: PasskeyCeremony, observe: CeremonyObserver) => Promise<T>,
) => Promise<T>
