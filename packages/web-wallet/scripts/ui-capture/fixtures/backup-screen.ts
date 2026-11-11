import * as actual from "../../../src/features/backupPasskey/backupScreen"
import { backupFixture, CAPTURE_NOW } from "./backup-passkey"
export * from "../../../src/features/backupPasskey/backupScreen"

/**
 * The host's input under the open fixture; what the fixture leaves out, taps still change. Once the
 * sheet's key read answers as the fixture says, the picked id is marked on the page, so a plan
 * waits for its screen whatever the screen says.
 */
export const selectBackupScreen: typeof actual.selectBackupScreen = (input) => {
  const fixture = backupFixture()
  if (!fixture) return actual.selectBackupScreen(input)
  const screen = actual.selectBackupScreen({ ...input, now: CAPTURE_NOW, ...fixture.input })
  const read = typeof input.keys === "object" ? "keys" : input.keys ?? "loading"
  if (read === (typeof fixture.keys === "object" ? "keys" : fixture.keys))
    document.documentElement.dataset.backupScreen = screen.id
  return screen
}
