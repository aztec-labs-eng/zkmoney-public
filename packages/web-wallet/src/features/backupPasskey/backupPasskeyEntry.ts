import type { BackupLinkHold, ChunkFit } from "@obsidion/front-core"

/** Where the user goes to clear a condition; `signOut` to sign in again with the first passkey. */
export type EntryAction = "activity" | "deposit" | "migration" | "savings" | "signOut"

/** What the entry checks. */
export interface EntryConditions {
  /** The session's credential is the account's first passkey. */
  sessionIsRoot: boolean
  verified: boolean
  /** The sign-up registration has yet to reach the rollup; the publish subscribes through it. */
  registering: boolean
  routeLive: boolean
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

/** An unmet condition, with what its words need. */
export type EntryCondition =
  | { id: "firstPasskey" }
  /** `finishing` once the account is registered and the registration has yet to land. */
  | { id: "registered"; finishing: boolean }
  | { id: "route" }
  | { id: "savings" }
  | { id: "withdrawal" }
  | { id: "link"; hold: BackupLinkHold }
  | { id: "migration" }
  | { id: "balance"; need: bigint; have: bigint }
  /** `send`: the self-send that joins the balance's small pieces. */
  | { id: "pieces"; send: bigint }
  | { id: "synced" }
  | { id: "uses" }

/** A condition that holds the add, and where the user goes to clear it. */
export type OpenEntryBlock = EntryCondition & { done: false; action?: EntryAction }

export type EntryBlock = OpenEntryBlock | { id: EntryCondition["id"]; done: true }

const met = (id: EntryCondition["id"]): EntryBlock => ({ id, done: true })

const unmet = (condition: EntryCondition, action?: EntryAction): EntryBlock => ({
  ...condition,
  done: false,
  ...(action && { action }),
})

const check = (ok: boolean, condition: EntryCondition, action?: EntryAction) =>
  ok ? met(condition.id) : unmet(condition, action)

/**
 * Every condition, in the order the first unmet one is named. A Savings move's burn is a withdrawal
 * too, so the withdrawal counts only without one.
 */
export function entryBlocks(c: EntryConditions): EntryBlock[] {
  const hold = c.linkHold
  const enough = c.balance >= c.fundingAmount
  return [
    check(c.sessionIsRoot, { id: "firstPasskey" }),
    check(c.verified && !c.registering, {
      id: "registered",
      finishing: c.verified && c.registering,
    }),
    check(c.routeLive, { id: "route" }),
    check(!c.savingsMoving, { id: "savings" }, "savings"),
    check(c.savingsMoving || !c.withdrawalInFlight, { id: "withdrawal" }, "activity"),
    // One that can only expire has nothing to open.
    hold
      ? unmet({ id: "link", hold }, hold.kind === "expiry" ? undefined : "activity")
      : met("link"),
    check(!c.historicBalance, { id: "migration" }, "migration"),
    check(enough, { id: "balance", need: c.fundingAmount, have: c.balance }, "deposit"),
    // A balance short of the funding never fits in one piece; its own row says so.
    c.chunk.kind === "short" && enough
      ? unmet({ id: "pieces", send: c.chunk.chunk })
      : met("pieces"),
    check(c.plan, { id: "synced" }),
    check(c.usesLeft, { id: "uses" }),
  ]
}
