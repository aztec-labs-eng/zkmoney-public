import * as actual from "../../../src/features/backupPasskey/backupRotations"
import { backupFixture } from "./backup-passkey"
export * from "../../../src/features/backupPasskey/backupRotations"

/**
 * The open fixture's saved attempt, as the Passkeys modal reads it: a saved attempt's screen then
 * stands alone, under no title or key list of the modal's, as in the app.
 */
export const useBackupRotation: typeof actual.useBackupRotation = (owner) => {
  const saved = actual.useBackupRotation(owner)
  const fixture = backupFixture()
  return fixture?.input.saved !== undefined ? fixture.input.saved : saved
}
