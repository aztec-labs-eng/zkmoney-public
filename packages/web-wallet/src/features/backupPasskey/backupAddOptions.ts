import {
  type BackupAddChoice,
  type BackupAddOptions,
  type PhoneReach,
  backupAddOptionsFor,
  currentUserAgentInfoSync,
  ignoresHintsFor,
  keptPasskeyApiFor,
  passkeyExtensionFor,
} from "@obsidion/passkey-web"
import type { IconName } from "@obsidion/web-ds"

/** The Passkeys sheet's backup options for what the probe said, with this page's own reads taken now. */
export function backupAddSheetOptions(input: { reach: PhoneReach }): BackupAddOptions {
  const ua = currentUserAgentInfoSync()
  return backupAddOptionsFor({
    reach: input.reach,
    extension: passkeyExtensionFor(),
    protonKept: keptPasskeyApiFor("create") !== undefined,
    ignoresHints: ignoresHintsFor(ua),
    os: ua.osFamily,
  })
}

export const BACKUP_ADD_ICONS: Readonly<Record<BackupAddChoice, IconName>> = {
  "1password": "lock",
  "proton": "lock",
  "computer": "fingerprint",
  "phone": "qr-code",
  "phone-or-key": "qr-code",
  "key": "key",
}
