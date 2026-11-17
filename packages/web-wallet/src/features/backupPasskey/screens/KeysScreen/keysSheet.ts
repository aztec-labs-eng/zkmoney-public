import type { BackupRotationRecord } from "@obsidion/front-core"
import { backupPasskeySettingsEnabled } from "../../../../config/features"

/**
 * Whether A1 lists the account's keys in place of the Passkeys modal's own list: the redesign is
 * on and the account has no backup yet. An account not registered yet lists none.
 */
export const keysSheetShows = (keys: number): boolean => backupPasskeySettingsEnabled && keys < 2

/**
 * Whether the host's screen stands alone, under no title or key list of the modal's: with the
 * redesign on, A1 and a pending attempt's screens.
 */
export const hostSheetShows = (keys: number, pending: BackupRotationRecord | null): boolean =>
  keysSheetShows(keys) || (backupPasskeySettingsEnabled && pending !== null)
