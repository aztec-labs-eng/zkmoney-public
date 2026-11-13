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

/** Home's and Settings' step under the open fixture: its driver, funding and release, at its time. */
export const selectAddStep: typeof actual.selectAddStep = (saved, input = {}) => {
  const fixture = backupFixture()
  if (!fixture) return actual.selectAddStep(saved, input)
  const { drive, funding, release } = fixture.input
  return actual.selectAddStep(saved, {
    ...input,
    ...(drive && { drive }),
    ...(funding && { funding }),
    ...(release && { release }),
    ...(input.now !== undefined && { now: CAPTURE_NOW }),
  })
}

/** How the Passkeys sheet closes under the open fixture: with its driver, as its screen reads it. */
export const selectSheetClose: typeof actual.selectSheetClose = (saved, drive) =>
  actual.selectSheetClose(saved, backupFixture()?.input.drive ?? drive)
