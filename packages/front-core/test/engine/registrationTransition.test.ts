import { describe, expect, it } from "vitest"
import {
  registrationTransition,
  type RegistrationEvent,
  type PendingRegistrationRecord,
  type RegistrationStart,
} from "../../src/engine/registrationTransition"

const NOW = 9_000
const SIPA = "0x00000000000000000000000000000000000000a1"
const OLD_SIPA = "0x00000000000000000000000000000000000000b2"
const TX = `0x${"cd".repeat(32)}` as const
const OTHER_TX = `0x${"ef".repeat(32)}` as const

const START: RegistrationStart = {
  account: "0x00000000000000000000000000000000000000c3",
  tag: "alice",
  nameHash: `0x${"11".repeat(32)}`,
  l2Address: `0x${"22".repeat(32)}`,
  l1ChainId: 1,
  sipaAddress: SIPA,
  fee: "10",
  beneficiary: "0x00000000000000000000000000000000000000d4",
  depositToken: "0x00000000000000000000000000000000000000e5",
}

const base: PendingRegistrationRecord = {
  ...START,
  phase: "awaiting_deposit",
  broadcast: false,
  retries: 0,
  startTime: 50,
  terms: { deadline: 1 },
}

const states: Record<string, Partial<PendingRegistrationRecord> | null> = {
  absent: null,
  awaiting: {},
  published: { broadcast: true },
  funded: { phase: "funded", fundedAt: 100, firstFundedAt: 100, fundingTxHash: TX },
  swept: { phase: "funded", fundedAt: 100, firstFundedAt: 100, sweptAt: 200, sweepTxHash: TX },
  submitted: {
    phase: "funded",
    fundedAt: 100,
    firstFundedAt: 100,
    fundingTxHash: TX,
    submittedFunding: { txHash: TX, at: NOW },
    submittedSweep: { txHash: OTHER_TX, at: NOW },
  },
  confirmed: { phase: "confirmed", endTime: 300 },
  taken: { phase: "failed_taken", endTime: 300 },
  failed: { phase: "failed_terminal", endTime: 300 },
  recovery: { phase: "confirmed", endTime: 300, notice: { recovery: true } },
  replaced: { phase: "replaced", endTime: 300 },
}

const entry = { sipaAddress: SIPA, recoveryTxHash: TX, amount: "10" }

const events: Record<string, RegistrationEvent> = {
  "started": { type: "started", record: START, terms: { deadline: 2 }, route: "invite" },
  "replaced": { type: "replaced" },
  "funded": { type: "funded", fundingTxHash: TX },
  "swept": { type: "swept", txHash: TX },
  "fundingSubmitted": { type: "fundingSubmitted", tx: { txHash: TX, at: NOW } },
  "sweepSubmitted": { type: "sweepSubmitted", tx: { txHash: TX, at: NOW } },
  "submissionFailed": { type: "submissionFailed", txHash: TX },
  "refunded": { type: "refunded", txHash: TX, amount: "10", entry },
  "broadcastSent": { type: "broadcastSent" },
  "predecessorBroadcast": { type: "predecessorBroadcast", sipaAddress: OLD_SIPA },
  "broadcastReset": { type: "broadcastReset" },
  "termsUpdated": { type: "termsUpdated", terms: { paylinkBlocked: true } },
  "lapsed": { type: "lapsed" },
  "closed confirmed": { type: "closed", outcome: "confirmed" },
  "closed taken": { type: "closed", outcome: "taken" },
  "closed failed": { type: "closed", outcome: "failed" },
  "closed recovery": { type: "closed", outcome: "recovery" },
  "noticeAcknowledged": { type: "noticeAcknowledged" },
  "abandoned": { type: "abandoned" },
  "tagConfirmed": { type: "tagConfirmed" },
  "retried": { type: "retried" },
}

const NONE = Object.fromEntries(Object.keys(events).map((e) => [e, "-"]))

/** Every event on an open record before custody. */
const OPEN: Record<string, string> = {
  "started": "awaiting_deposit terms",
  "replaced": "replaced endTime",
  "funded": "funded firstFundedAt,fundedAt,fundingTxHash",
  "swept": "funded firstFundedAt,fundedAt,sweepTxHash,sweptAt",
  "fundingSubmitted": "awaiting_deposit submittedFunding",
  "sweepSubmitted": "awaiting_deposit submittedSweep",
  "submissionFailed": "-",
  "refunded": "awaiting_deposit refundedEntry,refunds",
  "broadcastSent": "awaiting_deposit broadcast",
  "predecessorBroadcast": "awaiting_deposit replaced",
  "broadcastReset": "-",
  "termsUpdated": "awaiting_deposit terms",
  "lapsed": "awaiting_deposit lapsedAt",
  "closed confirmed": "confirmed endTime",
  "closed taken": "failed_taken endTime",
  "closed failed": "failed_terminal endTime",
  "closed recovery": "confirmed endTime,notice",
  "noticeAcknowledged": "-",
  "abandoned": "failed_terminal endTime,notice",
  "tagConfirmed": "awaiting_deposit tagConfirmed",
  "retried": "awaiting_deposit retries",
}

/** A funded record keeps its custody: abandon, fund and lapse no longer apply. */
const FUNDED: Record<string, string> = {
  ...OPEN,
  started: "funded terms",
  funded: "-",
  swept: "funded sweepTxHash,sweptAt",
  fundingSubmitted: "funded submittedFunding",
  sweepSubmitted: "funded submittedSweep",
  refunded: "awaiting_deposit fundedAt,fundingTxHash,refundedEntry,refunds",
  broadcastSent: "funded broadcast",
  predecessorBroadcast: "funded replaced",
  termsUpdated: "funded terms",
  lapsed: "-",
  abandoned: "-",
  tagConfirmed: "funded tagConfirmed",
  retried: "funded retries",
}

/** A closed record takes a reopening start, its broadcast, a refund and the user's acknowledgement. */
const closed = (phase: string, ack: string, notice = ""): Record<string, string> => ({
  ...NONE,
  started: `awaiting_deposit endTime,${notice}route,startTime,terms`,
  refunded: `${phase} refundedEntry,refunds`,
  broadcastSent: `${phase} broadcast`,
  noticeAcknowledged: ack,
})

// `phase changed-fields`, or "-" when the record is left as it is.
const table: Record<string, Record<string, string>> = {
  absent: { ...NONE, started: "new" },
  awaiting: OPEN,
  published: { ...OPEN, broadcastSent: "-", broadcastReset: "awaiting_deposit broadcast" },
  funded: FUNDED,
  swept: {
    ...FUNDED,
    swept: "-",
    refunded: "funded refunds",
  },
  // A failed receipt clears only its own hash; a refund that reopens the ask clears the transfer's.
  submitted: {
    ...FUNDED,
    // The same hash again rewrites the record as it is.
    fundingSubmitted: "funded ",
    submissionFailed: "funded submittedFunding",
    refunded: "awaiting_deposit fundedAt,fundingTxHash,refundedEntry,refunds,submittedFunding",
  },
  confirmed: closed("confirmed", "-"),
  taken: closed("failed_taken", "failed_taken notice"),
  failed: closed("failed_terminal", "failed_terminal notice"),
  recovery: closed("confirmed", "confirmed notice", "notice,"),
  replaced: closed("replaced", "-"),
}

const recordOf = (state: string) =>
  states[state] === null ? undefined : ({ ...base, ...states[state] } as PendingRegistrationRecord)

function outcome(state: string, event: string): string {
  const before = recordOf(state)
  const change = registrationTransition(before, events[event], NOW)
  if (!change) return "-"
  if (!before) return "new"
  const after = change.record as unknown as Record<string, unknown>
  const was = before as unknown as Record<string, unknown>
  const keys = new Set([...Object.keys(was), ...Object.keys(after)])
  const changed = [...keys]
    .filter((k) => k !== "phase" && JSON.stringify(was[k]) !== JSON.stringify(after[k]))
    .sort()
  return `${change.record.phase} ${changed.join(",")}`
}

describe("registrationTransition", () => {
  for (const state of Object.keys(states)) {
    for (const event of Object.keys(events)) {
      it(`${state} × ${event}`, () => {
        expect(outcome(state, event)).toBe(table[state][event])
      })
    }
  }

  it("creates an open record with its terms and route, at the start time", () => {
    const change = registrationTransition(undefined, events.started, NOW)
    expect(change?.record).toEqual({
      ...START,
      terms: { deadline: 2 },
      route: "invite",
      phase: "awaiting_deposit",
      broadcast: false,
      retries: 0,
      startTime: NOW,
    })
    expect(change?.first).toContain("startTime")
  })

  it("reopens a closed address with the refunds and confirmation it had, and nothing else", () => {
    const record: PendingRegistrationRecord = {
      ...base,
      phase: "failed_terminal",
      endTime: 300,
      tagConfirmed: true,
      refunds: { txHashes: [TX] },
      notice: { acknowledged: true },
      lapsedAt: 200,
    }
    const change = registrationTransition(record, events.started, NOW)
    expect(change?.record).toMatchObject({ tagConfirmed: true, refunds: { txHashes: [TX] } })
    expect(change?.record).not.toHaveProperty("notice")
    expect(change?.record).not.toHaveProperty("lapsedAt")
    // The address was seen before, so its creation is not new.
    expect(change?.first).not.toContain("startTime")
  })

  it("names a funnel field once: the write that first sets it", () => {
    const funded = registrationTransition(base, events.funded, NOW)
    expect(funded?.first).toEqual(expect.arrayContaining(["fundedAt"]))
    const swept = registrationTransition(funded?.record, events.swept, NOW + 1)
    expect(swept?.first).toEqual(["sweptAt", "sweepTxHash"])
    expect(swept?.record.fundedAt).toBe(NOW)
    expect(registrationTransition(swept?.record, events.swept, NOW + 2)).toBeUndefined()
    const lapsed = registrationTransition(base, events.lapsed, NOW)
    expect(lapsed?.first).toEqual(["lapsedAt"])
    expect(registrationTransition(lapsed?.record, events.lapsed, NOW + 1)).toBeUndefined()
  })

  it("sizes a refund once, and keeps every refund off the address", () => {
    const other = `0x${"ef".repeat(32)}` as const
    const unsized = registrationTransition(base, { type: "refunded", txHash: TX }, NOW)
    expect(unsized?.record.refunds).toEqual({ txHashes: [TX] })
    const sized = registrationTransition(
      unsized?.record,
      { type: "refunded", txHash: TX, amount: "4" },
      NOW,
    )
    expect(sized?.record.refunds).toEqual({ txHashes: [TX], amounts: { [TX]: "4" } })
    expect(
      registrationTransition(sized?.record, { type: "refunded", txHash: TX, amount: "9" }, NOW),
    ).toBeUndefined()
    const second = registrationTransition(
      sized?.record,
      { type: "refunded", txHash: other, amount: "6" },
      NOW,
    )
    expect(second?.record.refunds).toEqual({
      txHashes: [TX, other],
      amounts: { [TX]: "4", [other]: "6" },
    })
  })

  it("stamps the close time once: a later broadcast keeps it", () => {
    const record = { ...base, phase: "confirmed", endTime: 300 } as PendingRegistrationRecord
    expect(registrationTransition(record, events.broadcastSent, NOW)?.record.endTime).toBe(300)
  })

  it("keeps the predecessor a replacement already names when the rail is spent", () => {
    const record = {
      ...base,
      replaced: { sipaAddress: SIPA, refunded: true, broadcastSpent: false },
    }
    expect(
      registrationTransition(record, events.predecessorBroadcast, NOW)?.record.replaced,
    ).toEqual({ sipaAddress: SIPA, refunded: true, broadcastSpent: true })
  })

  it("closes an adopted name under the tag and hash the account holds", () => {
    const nameHash = `0x${"33".repeat(32)}` as const
    const change = registrationTransition(
      base,
      { type: "closed", outcome: "confirmed", tag: "bob", nameHash },
      NOW,
    )
    expect(change?.record).toMatchObject({ phase: "confirmed", tag: "bob", nameHash })
  })

  it("starts terms an update finds missing from the unknown deadline", () => {
    const { terms, ...bare } = base
    void terms
    const change = registrationTransition(
      bare,
      { type: "termsUpdated", terms: { proverTip: "7" } },
      NOW,
    )
    expect(change?.record.terms).toEqual({ deadline: 0, proverTip: "7" })
  })
})
