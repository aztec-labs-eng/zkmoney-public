// @vitest-environment node
// An open registration's facts: where it stands, and whether its tag settles.
import { describe, expect, it } from "vitest"
import {
  REGISTRATION_ASK_DEPOSIT_TOTAL,
  REGISTRATION_SCHEDULE_DEFAULTS,
} from "@obsidion/core/constants"
import type { RegistrationStage } from "../../src/core/services/registration"
import {
  pendingRecordState,
  selectPendingEntry,
  selectPendingExit,
  type PendingEntryFacts,
  type PendingExitFacts,
} from "../../src/engine/pendingEntry"
import type { RegistrationTerms } from "../../src/engine/registrationRecord"
import { pendingRegistration } from "../__test-helpers__/registrationFixtures"

const PAID = REGISTRATION_SCHEDULE_DEFAULTS.standard
const RANDOM = REGISTRATION_SCHEDULE_DEFAULTS.earned_tag
const NOW = 1_000_000_000_000
const record = pendingRegistration({ route: "random", fee: String(RANDOM.fee) })
const ticketBoundTerms = (over: Partial<RegistrationTerms> = {}): RegistrationTerms => ({
  deadline: NOW / 1000 + 7200,
  fee: "1",
  minDeposit: "0",
  feeWaived: true,
  paylinkFunded: true,
  paylinkId: "id:link",
  ...over,
})

/** A reserved address at a live quote that nothing funds or refunds: its tag settles. */
function facts(over: Partial<PendingEntryFacts> = {}): PendingEntryFacts {
  return {
    record,
    terms: null,
    stage: "reserved",
    paylinkStashed: false,
    depositAdmitted: false,
    refunded: false,
    depositSeen: 0n,
    shown: 0n,
    sweepFee: 0n,
    expectedEarned: false,
    feeWaived: false,
    signedQuote: undefined,
    claimDeadline: NOW / 1000 + 60,
    registrationsPaused: false,
    earnedAsk: REGISTRATION_ASK_DEPOSIT_TOTAL.earned_tag,
    nowMs: NOW,
    ...over,
  }
}

describe("where the open record stands", () => {
  it.each<[RegistrationStage | undefined, boolean, boolean, boolean]>([
    // stage, open, custody, awaiting
    [undefined, false, false, false],
    ["reserved", true, false, true],
    ["funding", true, false, true],
    ["received", true, true, false],
    ["crediting", true, true, false],
    ["registered", false, false, false],
    ["failed", false, false, false],
  ])("at %s", (stage, open, custody, awaiting) => {
    expect(pendingRecordState(record, stage, null)).toMatchObject({
      openPending: open,
      custodyHeld: custody,
      awaitingDeposit: awaiting,
    })
  })

  it("holds nothing without a record", () => {
    expect(pendingRecordState(null, "reserved", null).openPending).toBe(false)
  })

  it("asks no deposit while a link's burn funds the address", () => {
    const terms = ticketBoundTerms()
    expect(pendingRecordState(record, "funding", terms).linkBurnOut).toBe(true)
    expect(pendingRecordState(record, "reserved", terms).linkBurnOut).toBe(false)
    expect(pendingRecordState(record, "funding", null).linkBurnOut).toBe(false)
  })
})

describe("the tag settles", () => {
  it("on an address no link funds, at a live quote, while registrations take deposits", () => {
    expect(selectPendingEntry(facts()).settles).toBe(true)
  })

  it.each<[string, Partial<PendingEntryFacts>]>([
    ["no record", { record: null }],
    ["a stage still unknown", { stage: undefined }],
    ["a link on this tab that funds it", { paylinkStashed: true }],
    ["a link's burn on its way", { stage: "funding", terms: ticketBoundTerms() }],
    [
      "a link refused on its terms",
      {
        stage: "received",
        paylinkStashed: true,
        terms: ticketBoundTerms({ paylinkBlocked: true }),
      },
    ],
    ["a lapsed quote", { claimDeadline: NOW / 1000 - 1 }],
    ["an admitted deposit", { depositAdmitted: true }],
    ["paused registrations", { registrationsPaused: true }],
    [
      "a deposit the earned price must refund",
      { expectedEarned: true, depositSeen: 1n, sweepFee: BigInt(RANDOM.fee) + 1n },
    ],
    ["an earned quote the signer priced at standard", { expectedEarned: true, signedQuote: PAID }],
  ])("never under %s", (_, over) => {
    expect(selectPendingEntry(facts(over)).settles).toBe(false)
  })
})

describe("the quote", () => {
  it("lapses only while the address waits on a deposit nothing reached", () => {
    const lapsed = { claimDeadline: NOW / 1000 - 1 }
    expect(selectPendingEntry(facts(lapsed)).quoteExpired).toBe(true)
    expect(selectPendingEntry(facts({ ...lapsed, depositSeen: 1n })).quoteExpired).toBe(false)
    expect(selectPendingEntry(facts({ ...lapsed, depositAdmitted: true })).quoteExpired).toBe(false)
    expect(selectPendingEntry(facts({ ...lapsed, stage: "received" })).quoteExpired).toBe(false)
    expect(selectPendingEntry(facts({ claimDeadline: undefined })).quoteExpired).toBe(false)
  })

  it("an earned quote that waives the fee at the earned floor agrees with the promise", () => {
    const earned = { expectedEarned: true, signedQuote: RANDOM }
    expect(selectPendingEntry(facts({ ...earned, feeWaived: true })).quoteMismatch).toBe(false)
    expect(selectPendingEntry(facts(earned)).quoteMismatch).toBe(true)
  })

  it("a disagreeing quote replaces an address nothing reached, and watches one something did", () => {
    const differs = { expectedEarned: true, signedQuote: PAID }
    expect(selectPendingEntry(facts(differs)).replaceUnfunded).toBe(true)
    expect(selectPendingEntry(facts({ ...differs, depositSeen: 1n })).replaceUnfunded).toBe(false)
    const funded = facts({ ...differs, record: { ...record, fundedAt: 1 } })
    expect(selectPendingEntry(funded).replaceUnfunded).toBe(false)
  })

  it("a lapsed disagreeing quote is a refresh, not a mismatch", () => {
    const lapsed = { expectedEarned: true, signedQuote: PAID, claimDeadline: NOW / 1000 - 1 }
    expect(selectPendingEntry(facts(lapsed))).toMatchObject({
      quoteExpired: true,
      quoteMismatch: false,
    })
  })
})

describe("a link on this tab", () => {
  it("claims the address while the quote is live, and steps aside once it lapses", () => {
    expect(selectPendingEntry(facts({ paylinkStashed: true })).paylinkPending).toBe(true)
    const lapsed = facts({ paylinkStashed: true, claimDeadline: NOW / 1000 - 1 })
    expect(selectPendingEntry(lapsed).paylinkPending).toBe(false)
  })
})

describe("a refund", () => {
  it("is owed only for an earned tag that something reached", () => {
    const short = { sweepFee: BigInt(RANDOM.fee) + 1n }
    expect(selectPendingEntry(facts({ ...short, expectedEarned: true })).needsRefund).toBe(false)
    expect(selectPendingEntry(facts({ ...short, depositSeen: 1n })).needsRefund).toBe(false)
    expect(
      selectPendingEntry(facts({ ...short, expectedEarned: true, refunded: true })).needsRefund,
    ).toBe(true)
  })

  it("counts a deposit seen only while the address waits on one", () => {
    expect(selectPendingEntry(facts({ depositSeen: 1n })).depositSeenAny).toBe(true)
    const custody = facts({ depositSeen: 1n, stage: "received" })
    expect(selectPendingEntry(custody).depositSeenAny).toBe(false)
  })
})

describe("the pending step's exit", () => {
  const exit = (over: Partial<PendingExitFacts> = {}, phase = record.phase) =>
    selectPendingExit({
      record: { ...record, phase },
      identityTag: undefined,
      entered: false,
      admitted: false,
      refunded: false,
      keysHeld: false,
      signedIn: true,
      recoveryVisit: false,
      entryFailed: false,
      ...over,
    })
  const named = { identityTag: record.tag }

  it.each([
    ["failed_taken", {}, "restart"],
    ["failed_terminal", {}, "failed"],
    ["awaiting_deposit", { keysHeld: true }, "stay"],
    ["awaiting_deposit", { admitted: true, keysHeld: true }, "enter"],
    ["funded", { keysHeld: true }, "enter"],
    ["funded", {}, "stay"],
    ["funded", { ...named, entered: true }, "wallet"],
    ["funded", named, "recover"],
    ["funded", { signedIn: false }, "recover"],
    ["confirmed", { signedIn: false }, "recover"],
    ["awaiting_deposit", { signedIn: false }, "stay"],
    ["confirmed", { ...named, entered: true }, "wallet"],
    ["confirmed", { identityTag: "other", entered: true }, "stay"],
  ] as const)("at %s with %o: %s", (phase, over, expected) => {
    expect(exit(over, phase)).toBe(expected)
  })

  it("sends an account that holds another name to sign-in, keys or not", () => {
    const held = { ...record, phase: "confirmed" as const, notice: { recovery: true as const } }
    for (const keysHeld of [true, false])
      expect(
        selectPendingExit({
          record: held,
          identityTag: record.tag,
          entered: true,
          admitted: false,
          refunded: false,
          keysHeld,
          signedIn: true,
          recoveryVisit: false,
          entryFailed: false,
        }),
      ).toBe("held")
  })

  it("stays on a recovery visit while the deposit is the one to recover", () => {
    const visit = { recoveryVisit: true, keysHeld: true }
    expect(exit({ ...visit, admitted: true })).toBe("stay")
    expect(exit({ ...visit, refunded: true }, "funded")).toBe("stay")
    expect(exit(visit, "funded")).toBe("enter")
    expect(exit({ ...visit, admitted: true }, "confirmed")).toBe("enter")
  })

  it("stands down after a failed identity save, and holds without a record", () => {
    expect(exit({ entryFailed: true, keysHeld: true }, "confirmed")).toBe("stay")
    expect(exit({ record: null })).toBe("stay")
  })
})
