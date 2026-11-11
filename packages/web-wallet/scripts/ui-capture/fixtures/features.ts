import * as actual from "../../../src/config/features"
import { isDemoMode } from "../../../src/dev/demoFlag"
export * from "../../../src/config/features"

// The capture server strips every `VITE_*`, so a backup fixture turns on the flag its screens need.
export const backupPasskeySettingsEnabled =
  actual.backupPasskeySettingsEnabled ||
  (isDemoMode() && new URLSearchParams(location.search).has("backupFixture"))
