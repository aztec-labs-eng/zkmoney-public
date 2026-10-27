import {
  cancellable,
  fundingLanding,
  moveProgress,
  type BackupRotationAttention,
  type BackupRotationRecord,
} from "@obsidion/front-core"

/** Whether a funding of the record's may still reach the deposit address. */
const landing = (record: BackupRotationRecord) => record.fundings.some(fundingLanding)

/** The five steps the panel lists, in order. */
export const rotationSteps = [
  "Create backup",
  "Approve with your current passkey",
  "Fund",
  "Waiting for the network",
  "Finishing",
] as const

/** Which step a saved record is on; `rotationSteps.length` once every step is done. */
export function stepIndex(record: BackupRotationRecord): number {
  switch (record.phase) {
    case "created":
      return 1
    case "signed":
      return 2
    case "published":
      return landing(record) ? 3 : 2
    case "funded":
    case "swept":
    case "installed":
      return 3
    case "rerooted":
    case "moved":
      return 4
    default:
      return rotationSteps.length
  }
}

/** The install waits on Ethereum finality, so the step says how long and that the tab can go. */
const finalityWait =
  "Ethereum has to finalize your funding before the key is installed, which can take up to 40 minutes. " +
  "You can close this tab and come back later to finish."

/** The line under the current step. */
export function stepDetail(record: BackupRotationRecord): string | undefined {
  switch (record.phase) {
    case "signed":
      return "Publishing your deposit address. You can close this tab."
    case "published":
      return landing(record) ? "Your funding is on its way." : undefined
    case "funded":
      return `Your funding is on its way. ${finalityWait}`
    case "swept":
    case "installed":
      return finalityWait
    case "rerooted":
      return "Installing the key."
    case "moved": {
      const moved = moveProgress(record)
      return moved && moved.included < moved.total
        ? `Moving your balance (${moved.included} of ${moved.total}).`
        : "Moving your balance."
    }
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
  ahead:
    "You'll use two passkeys: first save the new backup, then approve it with the passkey you signed in with.",
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

export const entryCopy = {
  row: "Add a backup passkey",
  checking: "Checking…",
  unreadable: "Could not check, try again",
}

export const fundCopy = {
  destination: "Your new account",
  fees: "Fees",
  receive: "You'll receive",
  approvals: "Approvals",
  approvalsValue: (now: number, moves: number) => `${now} now, then ${moves} to move your balance`,
  takes: "Takes",
  takesValue: "Up to 40 minutes",
  afterSend: "Once sent, the funding cannot be cancelled. You can close this tab while it waits.",
  fund: "Fund and continue",
}

export const panelCopy = {
  approving: "Approving…",
  cancel: "Cancel",
  checkAgain: "Check again",
  tryAgain: "Try again",
  startOver: "Start over",
  done: "Done",
  doneLine:
    "Your backup passkey is ready. It opens this account on any device once that device signs in by tag.",
  recoveredLine: "This attempt ended and its funding was recovered.",
  cancelled: "Cancelled.",
  /** The passkey already saved on the device stays there; the account never lists it. */
  leftoverPasskey:
    "The backup passkey stays on your device but does not open this account. You can delete it from your passkey manager.",
  /** From `signed` on, the approval already given stays usable until the account next changes. */
  approvalStays: "The approval you gave stays usable until your account next changes.",
  conflict: "Your passkeys changed on another device. Start again from the current list.",
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

/**
 * What each attention state says and what the user can do about it from here. Once funded, only
 * the settlement can move the attempt on, so a funded state offers no action beyond running a
 * paused move again; dropping the attempt is offered only where the flow allows it.
 */
export function attentionCopy(
  reason: BackupRotationAttention,
  record: BackupRotationRecord,
): { line: string; actions: ("checkAgain" | "retry" | "cancel" | "startOver")[] } {
  switch (reason) {
    case "stranded":
      return {
        line: "Your funding is held at the deposit address. Nothing to do yet.",
        actions: [],
      }
    case "route":
      return {
        line: "The network is not paying for this right now.",
        actions: landing(record)
          ? []
          : cancellable(record)
          ? ["checkAgain", "cancel"]
          : ["checkAgain"],
      }
    case "corrupt":
      return cancellable(record)
        ? { line: "This attempt's record is damaged.", actions: ["startOver"] }
        : {
            line: "Your funding is held at the deposit address. Keep this browser; support can recover it.",
            actions: [],
          }
    case "move":
      return {
        line: "Part of your balance could not be moved yet. It stays yours on your previous account.",
        actions: ["retry"],
      }
    default:
      return unknownReason(reason)
  }
}

function unknownReason(reason: never): never {
  throw new Error(`backup add: unknown attention ${String(reason)}`)
}
