import { useState } from "react"
import { AlertBadge, NudgeCard, StatusBadge } from "@obsidion/web-ds"
import { fmt } from "../../../lib/fmt"
import { PasskeysSheet } from "../../../ui/PasskeysSheet/PasskeysSheet"
import { AccountHistorySheet } from "../AccountHistorySheet/AccountHistorySheet"
import type { HomeNudge } from "../backupReminder"
import { useBackupRotation } from "../backupRotations"
import { selectAddStep } from "../backupScreen"
import { minutes } from "../screens/AddTracker/AddTracker"
import { useBackupNudge, useHomeNudge } from "../useBackupNudge"
import copy from "./BackupNudge.copy"
import styles from "./BackupNudge.module.css"

/** A step under way: its card asks to go on, and can't be put off. */
const underWay = ({ kind }: HomeNudge) => kind !== "oneDevice" && kind !== "oneKey"

const actionLabel = ({ kind }: HomeNudge) => {
  switch (kind) {
    case "finish":
      return copy.finish.approve
    case "resume":
      return copy.resume.continue
    case "adding":
      return copy.adding.view
    case "moveFunds":
      return copy.moveFunds.continue
    default:
      return copy.add
  }
}

/** The network's card says the sheet's time left once read, or that the add is late. */
function bodyOf(nudge: HomeNudge) {
  if (nudge.kind !== "adding") return copy[nudge.kind].body
  if (nudge.delayed) return copy.adding.delayed
  if (nudge.leftMs === undefined) return copy.adding.body
  return nudge.leftMs > 0
    ? fmt(copy.adding.left, { minutes: minutes(nudge.leftMs) })
    : copy.adding.almost
}

function Card({
  nudge,
  className,
  onOpen,
  onDismiss,
}: {
  nudge: HomeNudge
  className?: string
  onOpen: () => void
  onDismiss?: () => void
}) {
  return (
    <div
      className={[styles.card, className].filter(Boolean).join(" ")}
      data-testid="backup-nudge"
      data-kind={nudge.kind}
    >
      {/* Announces a step change, not the network card's minute countdown. */}
      {underWay(nudge) && (
        <span className={styles.announce} aria-live="polite">
          {copy[nudge.kind].title}
        </span>
      )}
      <NudgeCard
        title={copy[nudge.kind].title}
        body={bodyOf(nudge)}
        action={{ label: actionLabel(nudge), onClick: onOpen }}
        dismissLabel={copy.notNow}
        onDismiss={onDismiss}
      />
    </div>
  )
}

/**
 * Home's card: go on with a saved add at its step, go on with a move from the earlier address, or
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
          nudge={nudge}
          onOpen={() => setSheet(nudge.kind === "moveFunds" ? "history" : "passkeys")}
          onDismiss={underWay(nudge) ? undefined : dismiss}
        />
      )}
      {/* Stays open once the add it starts saves its record and the card turns to its step. */}
      {sheet === "passkeys" && <PasskeysSheet onClose={() => setSheet(undefined)} />}
      {sheet === "history" && <AccountHistorySheet onClose={() => setSheet(undefined)} />}
    </>
  )
}

/** Settings' card under the avatar, while the account's only passkey lives on one device. */
export function SettingsBackupNudge({ onAdd }: { onAdd: () => void }) {
  const nudge = useBackupNudge()
  if (nudge !== "oneDevice") return null
  return <Card nudge={{ kind: nudge }} className={styles.settings} onOpen={onAdd} />
}

/** Settings' Passkeys row while an add is saved: "Finish setup" while it is on its tracker. */
export function BackupAddBadge() {
  const saved = useBackupRotation()
  const label = selectAddStep(saved)
    ? copy.finishSetup
    : saved !== null && typeof saved === "object"
    ? copy.pending
    : undefined
  return label ? <StatusBadge label={label} badgeStyle="pending" /> : null
}

/** The "!" on Settings and its Passkeys row while the account's only passkey lives on one device. */
export function BackupNudgeBadge({ className }: { className?: string }) {
  if (useBackupNudge() !== "oneDevice") return null
  return <AlertBadge label={copy.badge} className={className} />
}
