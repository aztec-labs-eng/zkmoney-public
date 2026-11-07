import type { BackupLinkHold, ChunkFit } from "@obsidion/front-core"
import { lockedUntil } from "../migration/residualNotes"

/** Where the user goes to clear a condition. */
export type EntryAction = "sponsorship" | "activity" | "migration" | "savings"

/** What the entry checks, in the order the first unmet one is shown. */
export interface EntryConditions {
  /** The session's credential is the account's first passkey. */
  sessionIsRoot: boolean
  verified: boolean
  routeLive: boolean
  /** The account holds the sponsored-transaction subscription. */
  registered: boolean
  /** A Savings move has yet to land; it would land on the one-key account. */
  savingsMoving: boolean
  withdrawalInFlight: boolean
  /** An open paylink the add can't take back itself, so it waits on it. */
  linkHold?: BackupLinkHold
  historicBalance: boolean
  balance: bigint
  fundingAmount: bigint
  chunk: ChunkFit
  /** A move plan exists over the live balances. */
  plan: boolean
  /** Sponsored uses left for the whole flow. */
  usesLeft: boolean
}

export type EntryBlock = { line: string; action?: EntryAction }

function linkHoldBlock(hold: BackupLinkHold, date: (sec: number) => string): EntryBlock {
  switch (hold.kind) {
    case "creating":
      return { line: "Finish creating your paylink first", action: "activity" }
    case "token":
      return { line: "Cancel your paylinks from before the upgrade first", action: "activity" }
    case "cancel":
      return { line: "Cancel your paylink in Activity first", action: "activity" }
    case "expiry":
      return {
        line: `A paylink you made can't be cancelled until it expires on ${date(
          hold.until,
        )}. Try again then.`,
      }
  }
}

/** The first unmet condition, or undefined when the entry is ready to press. */
export function entryBlock(
  c: EntryConditions,
  amount: (atomic: bigint) => string,
  date: (sec: number) => string = lockedUntil,
): EntryBlock | undefined {
  if (!c.sessionIsRoot) return { line: "Use your first passkey to add a backup" }
  if (!c.verified) return { line: "This account is not registered yet" }
  if (!c.routeLive) return { line: "Not available on this network yet" }
  if (!c.registered) return { line: "Sponsored transactions are not set up", action: "sponsorship" }
  // Before the withdrawal line: a Savings move's burn is a withdrawal too.
  if (c.savingsMoving) return { line: "Finish your Savings move first", action: "savings" }
  if (c.withdrawalInFlight) return { line: "Finish your withdrawal first", action: "activity" }
  if (c.linkHold) return linkHoldBlock(c.linkHold, date)
  if (c.historicBalance) return { line: "Finish your migration first", action: "migration" }
  if (c.balance < c.fundingAmount)
    return { line: `You need at least ${amount(c.fundingAmount)} to add a backup` }
  if (c.chunk.kind === "short")
    return {
      line: `Your balance is in too many small pieces to fund this. Send yourself ${amount(
        c.chunk.chunk,
      )} first.`,
    }
  if (!c.plan) return { line: "Part of your balance is still syncing. Try again in a moment." }
  if (!c.usesLeft) return { line: "Not enough sponsored transactions left this period" }
  return undefined
}
