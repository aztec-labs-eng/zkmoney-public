import { useState, useSyncExternalStore } from "react"
import { useStore } from "@obsidion/front-core"
import { backupPasskeySettingsEnabled } from "../../../config/features"
import { backupRecordFor } from "../../../platform/auth/WebPasskeyIdentityMap"
import { useSession } from "../../../session/session"
import { PasskeysSheet } from "../../../ui/PasskeysSheet/PasskeysSheet"
import {
  backupReminderApplies,
  backupReminderDismissed,
  backupSeenOnChain,
} from "../backupReminder"
import { useBackupRotation } from "../backupRotationStore"
import copy from "./BackupReminderLine.copy"
import styles from "./BackupReminderLine.module.css"

/** Home's reminder to add a backup passkey while the account's only passkey lives on one device. */
export function BackupReminderLine() {
  const saved = useBackupRotation()
  const dismissed = useSyncExternalStore(
    backupReminderDismissed.subscribe,
    backupReminderDismissed.get,
  )
  const backupOnChain = useSyncExternalStore(backupSeenOnChain.subscribe, backupSeenOnChain.get)
  const [sheet, setSheet] = useState(false)
  const { credentialId, passkeyMap } = useStore(useSession().device)
  const show = backupReminderApplies({
    enabled: backupPasskeySettingsEnabled,
    record: credentialId ? backupRecordFor(passkeyMap, credentialId) : undefined,
    noAddSaved: saved === null,
    backupOnChain,
    dismissed,
  })
  return (
    <>
      {show && (
        <div className="ww-banner ww-banner--static" data-testid="backup-reminder-line">
          <span className="ww-banner__text">
            <span className="ww-banner__title">{copy.title}</span>
            <span className="ww-banner__body">{copy.body}</span>
            <span className={styles.actions}>
              <button
                type="button"
                className="zkm-btn-reset ww-deposit__link"
                onClick={() => setSheet(true)}
                data-testid="backup-reminder-add"
              >
                {copy.add}
              </button>
              <button
                type="button"
                className={`zkm-btn-reset ${styles.later}`}
                onClick={() => backupReminderDismissed.set(true)}
                data-testid="backup-reminder-dismiss"
              >
                {copy.notNow}
              </button>
            </span>
          </span>
        </div>
      )}
      {/* Stays open once the add it starts saves its record and the line steps aside. */}
      {sheet && <PasskeysSheet onClose={() => setSheet(false)} />}
    </>
  )
}
