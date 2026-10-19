import type { MetadataMigrationPhase, MetadataMigrationRecord } from "@obsidion/front-core"

/** Where a run stands, as the upgrade dialog says it. */
export const upgradePhaseLabel: Record<MetadataMigrationPhase, string> = {
  preparing: "Preparing your upgrade",
  broadcasting: "Sending your upgrade",
  funding: "Waiting for funds to upgrade",
  awaitingMessages: "Waiting for your first transfer to arrive",
  subscribing: "Setting up your account on the new version",
  recovering: "Sending your remaining funds",
  arriving: "Your funds are on their way",
  done: "Upgrade complete",
  needsAttention: "Your upgrade needs attention",
  needsApproval: "Your upgrade needs your approval",
}

/** What stopped a run and what the user can do, in their terms; the cause itself goes to the console. */
export function upgradeStopText(record: MetadataMigrationRecord): string {
  if (record.phase === "needsApproval") return "Your upgrade needs another approval to continue."
  if (record.halt === "account")
    return "This upgrade no longer matches your wallet setup. Try again. If it still stops, report a bug in Settings."
  if (record.halt === "reverted")
    return "A transaction in your upgrade failed. Try again to check whether it can continue. If it keeps failing, report a bug in Settings."
  if (record.halt === "recipient")
    return "The address prepared for one of your transfers no longer matches, so that transfer was not sent. Try again to check whether it can continue. If it keeps failing, report a bug in Settings."
  if (record.stale)
    return published(record)
      ? "Your upgrade no longer matches what was prepared. Try again to check whether it can continue."
      : "Your upgrade plan is out of date. Continue to prepare it again; you may be asked to approve again."
  if (record.refused) return "The passkey request was closed or timed out. Continue to try again."
  return "Your upgrade couldn't finish a step. Continue to try again."
}

/** The dialog's button for a saved run: what continuing does next. */
export function continueLabel(record: MetadataMigrationRecord): string {
  if (record.phase === "needsAttention" && (record.halt || (record.stale && published(record))))
    return "Try again"
  const approvals = record.approvals
  if (approvals && approvals.approved < approvals.total)
    return `Continue approving (${approvals.approved + 1} of ${approvals.total})`
  if (record.phase === "needsApproval") return "Approve and continue"
  return "Continue upgrade"
}

/** Something was sent: a stale plan is kept, not prepared again. */
const published = (record: MetadataMigrationRecord) =>
  !!record.bootstrapTx || !!record.subscriptionTx
