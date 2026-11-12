import { useState } from "react"
import { AlertBadge, NudgeCard } from "@obsidion/web-ds"
import { PasskeysSheet } from "../../../ui/PasskeysSheet/PasskeysSheet"
import { AccountHistorySheet } from "../AccountHistorySheet/AccountHistorySheet"
import type { HomeNudge } from "../backupReminder"
import { useBackupNudge, useHomeNudge } from "../useBackupNudge"
import copy from "./BackupNudge.copy"
import styles from "./BackupNudge.module.css"

type Kind = HomeNudge["kind"]

/** A step under way: its card asks to go on, and can't be put off. */
const underWay = (kind: Kind) => kind === "finish" || kind === "moveFunds"

const actionLabel = (kind: Kind) =>
  kind === "finish"
    ? copy.finish.approve
    : kind === "moveFunds"
    ? copy.moveFunds.continue
    : copy.add

function Card({
  kind,
  className,
  onOpen,
  onDismiss,
}: {
  kind: Kind
  className?: string
  onOpen: () => void
  onDismiss?: () => void
}) {
  return (
    <div
      className={[styles.card, className].filter(Boolean).join(" ")}
      data-testid="backup-nudge"
      aria-live={underWay(kind) ? "polite" : undefined}
    >
      <NudgeCard
        title={copy[kind].title}
        body={copy[kind].body}
        action={{ label: actionLabel(kind), onClick: onOpen }}
        dismissLabel={copy.notNow}
        onDismiss={onDismiss}
      />
    </div>
  )
}

/**
 * Home's card: approve a waiting add's last step, go on with a move from the earlier address, or
 * add a backup passkey. The move opens Account history; the others open the Passkeys sheet, which
 * shows the add's current step.
 */
export function BackupNudge() {
  const { nudge, dismiss } = useHomeNudge()
  const [sheet, setSheet] = useState<"passkeys" | "history">()
  return (
    <>
      {nudge && (
        <Card
          kind={nudge.kind}
          onOpen={() => setSheet(nudge.kind === "moveFunds" ? "history" : "passkeys")}
          onDismiss={underWay(nudge.kind) ? undefined : dismiss}
        />
      )}
      {/* Stays open once the add it starts saves its record and the card steps aside. */}
      {sheet === "passkeys" && <PasskeysSheet onClose={() => setSheet(undefined)} />}
      {sheet === "history" && <AccountHistorySheet onClose={() => setSheet(undefined)} />}
    </>
  )
}

/** Settings' card under the avatar, while the account's only passkey lives on one device. */
export function SettingsBackupNudge({ onAdd }: { onAdd: () => void }) {
  const nudge = useBackupNudge()
  if (nudge !== "oneDevice") return null
  return <Card kind={nudge} className={styles.settings} onOpen={onAdd} />
}

/** The "!" on Settings and its Passkeys row while the account's only passkey lives on one device. */
export function BackupNudgeBadge({ className }: { className?: string }) {
  if (useBackupNudge() !== "oneDevice") return null
  return <AlertBadge label={copy.badge} className={className} />
}
