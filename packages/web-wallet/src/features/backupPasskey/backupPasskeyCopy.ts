import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import type { BackupRotationAttention } from "@obsidion/front-core"
import { formatUnits } from "viem"
import { tokenFigure } from "../../ui/format"
import type { BackupProgress } from "./backupScreen"

export const formatDai = (atomic: bigint) =>
  tokenFigure(formatUnits(atomic, DEFAULT_DECIMALS), "DAI")

/** The five steps the panel lists, in order. */
export const rotationSteps = [
  "Create backup",
  "Approve with your current passkey",
  "Fund",
  "Waiting for the network",
  "Finishing",
] as const

/** Which of the five steps an attempt is on. */
export function stepIndex({ stage }: BackupProgress): number {
  switch (stage) {
    case "sign":
      return 1
    case "publish":
    case "pay":
      return 2
    case "landing":
    case "funded":
    case "final":
      return 3
    case "installing":
    case "moving":
      return 4
  }
}

/** The line under the current step. */
export function stepDetail({ stage, refunds, moved }: BackupProgress): string | undefined {
  switch (stage) {
    case "publish":
      return "Publishing your deposit address. You can close this tab."
    case "landing":
      return "Your funding is on its way."
    case "funded":
      return "Your funding is on its way. You can close this tab and come back later to finish."
    case "final":
      return "Your funding was swept. Finishing on this device."
    case "installing":
      return "Installing the key."
    case "moving":
      if (refunds) return `Cancelling your payment links (${refunds.landed} of ${refunds.total}).`
      return moved && moved.included < moved.total
        ? `Moving your balance (${moved.included} of ${moved.total}).`
        : "Moving your balance."
    default:
      return undefined
  }
}

/** A line split around the approving passkey's name, which the panel sets in bold. */
export type NamedLine = readonly [before: string, name: string, after: string]

/**
 * The approval step. Only a key already on the account can sign the add, which in a session that
 * started it is the one it signed in with; `name` is that key as the key list names it.
 */
export const approveCopy = {
  button: (name?: string) => `Approve with ${name ?? "your current passkey"}`,
  detail: (name?: string): NamedLine =>
    name
      ? [
          "Use ",
          name,
          " (the one you signed in with). Only a passkey already on your account can add a new one.",
        ]
      : [
          "Use the passkey you signed in with. Only a passkey already on your account can add a new one.",
          "",
          "",
        ],
  declined: (name?: string): NamedLine =>
    name
      ? ["Use ", name, ", the passkey you signed in with. The new backup can't approve itself."]
      : ["Use the passkey you signed in with. The new backup can't approve itself.", "", ""],
}

/**
 * The move: each open payment link's refund, then each chunk's send, waits for a tap, then asks the
 * passkey the account was built over.
 */
export const moveCopy = {
  line: ({ refunds, moved }: BackupProgress) => {
    if (refunds)
      return refunds.total > 1
        ? `Approve cancelling payment link ${refunds.landed + 1} of ${refunds.total}.`
        : "Approve cancelling your open payment link."
    return moved && moved.total > 1
      ? `Approve moving part ${moved.included + 1} of ${
          moved.total
        } of your balance to your new account.`
      : "Approve moving your balance to your new account."
  },
  /** A link too close to its expiry to cancel is reclaimed once it expires. */
  linkExpiring: "A payment link is about to expire. It's reclaimed once it does.",
  /** Home's line while the move waits for the user. */
  home: "Your backup passkey is almost ready",
  homeDetail: "Approve moving your balance to finish.",
  resume: "Resume in Settings",
}

export const entryCopy = {
  checking: "Checking…",
  unreadable: "Could not check, try again",
}

/** Why a new paylink waits for the add: its escrow would refund only the account the add moves off. */
export const linkWaitsCopy = {
  title: "Finish adding your backup passkey",
  message:
    "A paylink made now couldn't be cancelled or reclaimed once your backup passkey is added. Finish adding it in Settings first.",
}

/** The add's figures, on the Fund step and the funding's Activity sheet. */
export const costCopy = {
  // Proposed.
  sent: "Sent to set up your new account",
  fees: "Fees",
  withdrawalFee: "Withdrawal fee",
  // Proposed.
  accountChangeFee: "Account change fee",
  // Proposed: the sheet's, once the leftover is back.
  returned: "Returned to your balance",
}

// Proposed: new copy for a Savings move held while an add has yet to switch the account.
export const savingsWaitsCopy = {
  title: "Finish adding your backup passkey",
  message:
    "Funds moved in or out of Savings now couldn't reach your account once your backup passkey is added. Finish adding it in Settings first.",
}

export const fundCopy = {
  destination: "Your new account",
  receive: "You'll receive",
  approvals: "Approvals",
  approvalsValue: (now: number, moves: number, refunds = 0) =>
    refunds > 0
      ? `${now} now, then ${refunds} to cancel your payment ${
          refunds === 1 ? "link" : "links"
        } and ${moves} to move your balance`
      : `${now} now, then ${moves} to move your balance`,
  takes: "Takes",
  // Proposed: the chosen speed's ETA, worded as the speed picker words it.
  /** The chosen speed's ETA line, or the withdrawal's own bound when no speed is offered. */
  takesValue: "Up to 40 minutes",
  afterSend: "Once sent, the funding cannot be cancelled. You can close this tab while it waits.",
  fund: "Fund and continue",
}

export const panelCopy = {
  title: "Backup passkey",
  approving: "Approving…",
  cancel: "Cancel",
  tryAgain: "Try again",
  done: "Done",
  doneLine:
    "Your backup passkey is ready. It opens this account on any device once that device signs in by tag.",
  cancelled: "Cancelled.",
  /** The passkey already saved on the device stays there; the account never lists it. */
  leftoverPasskey:
    "The backup passkey stays on your device but does not open this account. You can delete it from your passkey manager.",
  /** From `signed` on, the approval already given stays usable until the account next changes. */
  approvalStays: "The approval you gave stays usable until your account next changes.",
  unverifiable: "Could not check, try again",
  fundingOnItsWay: "Your funding is on its way.",
  notCancellable:
    "This attempt cannot be dropped: money may have reached its deposit address. Keep this browser.",
  routeNotLive: "Not available on this network yet",
  /** The device minted an id longer than a backup key can carry; no retry changes it. */
  credentialIdTooLong:
    "This passkey can't be a backup: its credential id is longer than the account can store. Cancel and use another passkey.",
  declined: "The passkey request was closed or timed out.",
}

/** The recovery card's copy. */
export const recoveryCopy = {
  title: "Backup not added",
  started: (when: string) => `Started ${when}`,
  extraTitle: "Extra funding held",
  extraSubtitle: "Backup passkey added",
  // Proposed: `unread`, while this device's attempts are not read.
  badge: {
    held: "Needs recovery",
    sent: "Recovering",
    recovered: "Recovered",
    unread: "Pending",
  } as const,
  line: {
    held: "Adding this backup stopped. Your funding is safe at its deposit address.",
    damaged: "This attempt's record is damaged. Its funding is safe at the deposit address.",
    extra: "Funding arrived after your backup was added. It is safe at the deposit address.",
    sent: "Recovery sent. It lands in a few minutes. You can close this window.",
    recovered: "Your funds were sent back. This backup was not added, so you can start a new one.",
  },
  funding: "Funding",
  depositAddress: "Deposit address",
  recovery: "Recovery",
  gas: "You'll need an Ethereum wallet with ETH for gas.",
  recover: "Recover funds",
  later: "Funding that reaches the address later can be recovered too.",
  checkAddress: "Check the address",
  nothingNew: "Nothing new at the deposit address.",
  nothingYet: "Nothing at the deposit address right now. This updates shortly.",
  done: "Done",
  /** The funding's Activity sheet, which sends the user to the card. */
  activity: {
    // Proposed: the sheet's lines for each state.
    line: {
      held: "This backup was not added. Its funding is safe at the deposit address until you recover it.",
      sent: "Recovery sent. It lands in a few minutes.",
      recovered: "This backup was not added. Your funds were sent back to Ethereum.",
      unread: "Whether this backup was added is not known yet. Passkeys shows where it stands.",
    },
    // Proposed: titles a stopped add's row and sheet.
    notAdded: "Backup passkey not added",
    // Proposed.
    sentBack: "Sent back",
    recoveryTx: "Recovery tx",
    // Proposed.
    openPasskeys: "Open Passkeys",
  },
}

/** What each parked state says. Funding held at the deposit address shows on the recovery card. */
export const attentionLine: Record<Exclude<BackupRotationAttention, "stranded">, string> = {
  route: "The network is not paying for this right now.",
  corrupt: "This attempt's record is damaged.",
  move: "Part of your balance could not be moved yet. It stays yours on your previous account.",
}

/** Why sponsored spends wait while a rotation moves the balance: the move pays with the same note. */
export const balanceMovingCopy = {
  title: "Moving your balance",
  message:
    "Your balance is moving to your new account. Sending, withdrawing, Savings and payment links open again once the move finishes.",
}
