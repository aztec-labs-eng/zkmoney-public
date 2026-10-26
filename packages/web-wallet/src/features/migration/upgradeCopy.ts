import type { MetadataMigrationPhase, MetadataMigrationRecord } from "@obsidion/front-core"
import type { WalletAction } from "../actionGate"
import type { UpgradeStatus } from "./migrationDialog"

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

/** The sheet that offers the upgrade (Figma 12709:36185). */
export const offerCopy = {
  title: "Upgrade to a faster zk.money",
  lead: "Upgrade to send and receive faster. It takes about 40 minutes, and your balance stays safe.",
  /** A destination without the metadata flow moves a live balance whole. */
  liveLead: "Upgrade to send and receive faster. Your balance stays safe.",
}

/**
 * The sheet when nothing on an old version can pay for the upgrade, so a deposit funds it (Figma
 * 12725:50430). `minimum` is the least to send, once read.
 */
export const depositToUpgradeCopy = {
  banner: {
    title: "Upgrade to keep your tag",
    body: "A better wallet with quicker transactions. Tap to upgrade.",
  },
  title: "Deposit to keep your tag",
  lead: (minimum?: string) =>
    `Your balance is too low to cover the network fee. ${
      minimum ? `Deposit at least ${minimum}` : "Deposit funds"
    } and the upgrade runs on its own.`,
  fees: "Network fees",
  tip: "The upgrade works as a deposit, and every deposit pays a small network fee that comes out of what you send.",
  button: "Deposit funds & upgrade",
  depositTitle: "Deposit to upgrade",
  creating: "Just a moment, we're making your address private.",
}

/** Under a running upgrade, until it no longer needs the tab. */
export const keepTabOpen = "Keep this tab open until your funds are sent, usually a few minutes."

/** The sheet's fee, and why it is charged behind its "?" (Figma 12725:37307). */
export const upgradeFeeLabel = (fees: string) => `Costs ${fees} in network fees`
export const upgradeFeeTip =
  "Moving your funds onto the new network works as a deposit, and every deposit pays a small network fee that comes out of your balance."

/** The sheet when an action waits on the upgrade (Figma 12709:37036). */
export const actionUpgradeTitle: Record<WalletAction, string> = {
  send: "Upgrade to send",
  receive: "Upgrade to receive",
  deposit: "Upgrade to deposit",
  withdraw: "Upgrade to withdraw",
  link: "Upgrade to create a link",
  savings: "Upgrade to use Savings",
  claim: "Upgrade to claim",
}

/** Under an action's title while the wallet checks whether the account must upgrade first. */
export const checkingLead = "Checking whether your account needs to upgrade first."

/** The dialog for an account whose registration is current here but not active yet. */
export const finishingCopy = {
  title: "Finish your upgrade",
  lead: "Your account is being set up on the new version. Sending and withdrawing open once it's ready, in a few minutes.",
}

/** The dialog over a run the wallet follows to the end by itself. */
export const followingLead = "Your funds are on their way. Nothing more is needed from you."

/** Home's banner for where the upgrade stands (Figma 12709:35478); none while there is nothing to say. */
export function upgradeBannerCopy(status: UpgradeStatus): { title: string; body?: string } | null {
  switch (status.state) {
    case "offered":
      return status.external
        ? depositToUpgradeCopy.banner
        : {
            title: "Faster zk.money available",
            body: "A better wallet with quicker transactions. Tap to upgrade.",
          }
    case "finishing":
      return { title: finishingCopy.title }
    case "running":
    case "stopped":
      return { title: status.phase ? upgradePhaseLabel[status.phase] : "Upgrading…" }
    case "failed":
      return { title: "Couldn't check your old funds", body: "Tap to try again." }
    default:
      return null
  }
}
