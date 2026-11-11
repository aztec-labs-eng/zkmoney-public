import { useState } from "react"
import { AlertBadge, NudgeCard } from "@obsidion/web-ds"
import { PasskeysSheet } from "../../../ui/PasskeysSheet/PasskeysSheet"
import { useBackupNudge, useHomeNudge } from "../useBackupNudge"
import copy from "./BackupNudge.copy"
import styles from "./BackupNudge.module.css"

function Card({
  kind,
  className,
  onOpen,
  onDismiss,
}: {
  kind: "finish" | "oneDevice" | "oneKey"
  className?: string
  onOpen: () => void
  onDismiss?: () => void
}) {
  return (
    <div
      className={[styles.card, className].filter(Boolean).join(" ")}
      data-testid="backup-nudge"
      aria-live={kind === "finish" ? "polite" : undefined}
    >
      <NudgeCard
        title={copy[kind].title}
        body={copy[kind].body}
        action={{ label: kind === "finish" ? copy.finish.approve : copy.add, onClick: onOpen }}
        dismissLabel={copy.notNow}
        onDismiss={onDismiss}
      />
    </div>
  )
}

/**
 * Home's card: approve a waiting add's last step, or add a backup passkey. Each opens the Passkeys
 * sheet, which shows the add's current step.
 */
export function BackupNudge() {
  const { nudge, dismiss } = useHomeNudge()
  const [sheet, setSheet] = useState(false)
  return (
    <>
      {nudge && (
        <Card
          kind={nudge.kind}
          onOpen={() => setSheet(true)}
          // A step under way can't be put off.
          onDismiss={nudge.kind === "finish" ? undefined : dismiss}
        />
      )}
      {/* Stays open once the add it starts saves its record and the card steps aside. */}
      {sheet && <PasskeysSheet onClose={() => setSheet(false)} />}
    </>
  )
}

/** Settings' card under the avatar, while the account has one passkey. */
export function SettingsBackupNudge({ onAdd }: { onAdd: () => void }) {
  const nudge = useBackupNudge()
  return nudge ? <Card kind={nudge} className={styles.settings} onOpen={onAdd} /> : null
}

/** The "!" on Settings and its Passkeys row while the account has one passkey. */
export function BackupNudgeBadge({ className }: { className?: string }) {
  return useBackupNudge() ? <AlertBadge label={copy.badge} className={className} /> : null
}
