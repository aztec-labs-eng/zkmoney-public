import { describe, expect, it } from "vitest"
import {
  paylinkTransition,
  type PaylinkEvent,
  type PaylinkRecord,
} from "../../src/engine/paylinkTransition"

const base: PaylinkRecord = {
  id: "0xid",
  timestamp: 1,
  amountAtomic: 5n,
  flavor: "direct",
  payToEmailSecret: "0xsecret",
}

const STATES: Record<string, Partial<PaylinkRecord>> = {
  prepared: { paylink: "u0" },
  sent: { txHash: "0xa", paylink: "u0" },
  funded: { txHash: "0xa", paylink: "u1" },
  claimed: { txHash: "0xa", paylink: "u1", isClaimed: true, claimedBy: "chain", claimedAt: 5 },
  claimedSelf: { txHash: "0xa", isClaimed: true, claimedBy: "self", claimedAt: 5 },
  refunding: { txHash: "0xa", paylink: "u1", refundTxHash: "0xr", refundKind: "cancel" },
  refunded: { txHash: "0xa", isRefunded: true, refundTxHash: "0xr", refundKind: "cancel" },
  migrated: { txHash: "0xa", paylink: "u1", isMigrated: true },
}

const EVENTS: Record<string, PaylinkEvent> = {
  sent: { type: "sent", txHash: "0xa" },
  sentOther: { type: "sent", txHash: "0xb" },
  funded: { type: "funded", paylink: "u2" },
  byChain: { type: "claimed", at: 9, refundInFlight: false, by: "chain" },
  bySelf: { type: "claimed", at: 9, refundInFlight: false, by: "self" },
  midRefund: { type: "claimed", at: 9, refundInFlight: true, by: "chain" },
  staleClaim: { type: "claimed", at: 9, epoch: 1, refundInFlight: false, by: "chain" },
  unclaimed: { type: "unclaimed" },
  staleUnclaim: { type: "unclaimed", epoch: 1 },
  refundSubmitted: { type: "refundSubmitted", refundTxHash: "0xr", refundKind: "cancel" },
  refunded: { type: "refunded", refundTxHash: "0xs" },
  refundDropped: { type: "refundDropped", refundTxHash: "0xr" },
  migrated: { type: "migrated" },
}

/** funding hash, URL, claimant, refund hash, flags, epoch. */
const summary = (l: PaylinkRecord) =>
  [
    l.txHash ?? "-",
    l.paylink ?? "-",
    l.isClaimed ? l.claimedBy : "-",
    l.refundTxHash ?? "-",
    l.isRefunded && "refunded",
    l.isMigrated && "migrated",
    `e${l.reorgEpoch ?? 0}`,
  ]
    .filter(Boolean)
    .join(" ")

// The link after each event, from each state; a cell equal to its state's own is no change.
const TABLE: Record<string, Record<string, string>> = {
  prepared: {
    sent: "0xa u0 - - e0",
    sentOther: "0xb u0 - - e0",
    funded: "- u0 - - e0",
    byChain: "- u0 chain - e0",
    bySelf: "- - self - e0",
    midRefund: "- u0 - - e0",
    staleClaim: "- u0 - - e0",
    unclaimed: "- u0 - - e0",
    staleUnclaim: "- u0 - - e0",
    refundSubmitted: "- u0 - 0xr e0",
    refunded: "- - - 0xs refunded e0",
    refundDropped: "- u0 - - e0",
    migrated: "- u0 - - migrated e0",
  },
  sent: {
    sent: "0xa u0 - - e0",
    sentOther: "0xa u0 - - e0",
    funded: "0xa u2 - - e0",
    byChain: "0xa u0 chain - e0",
    bySelf: "0xa - self - e0",
    midRefund: "0xa u0 - - e0",
    staleClaim: "0xa u0 - - e0",
    unclaimed: "0xa u0 - - e0",
    staleUnclaim: "0xa u0 - - e0",
    refundSubmitted: "0xa u0 - 0xr e0",
    refunded: "0xa - - 0xs refunded e0",
    refundDropped: "0xa u0 - - e0",
    migrated: "0xa u0 - - migrated e0",
  },
  funded: {
    sent: "0xa u1 - - e0",
    sentOther: "0xa u1 - - e0",
    funded: "0xa u2 - - e0",
    byChain: "0xa u1 chain - e0",
    bySelf: "0xa - self - e0",
    midRefund: "0xa u1 - - e0",
    staleClaim: "0xa u1 - - e0",
    unclaimed: "0xa u1 - - e0",
    staleUnclaim: "0xa u1 - - e0",
    refundSubmitted: "0xa u1 - 0xr e0",
    refunded: "0xa - - 0xs refunded e0",
    refundDropped: "0xa u1 - - e0",
    migrated: "0xa u1 - - migrated e0",
  },
  claimed: {
    sent: "0xa u1 chain - e0",
    sentOther: "0xa u1 chain - e0",
    funded: "0xa u1 chain - e0",
    byChain: "0xa u1 chain - e0",
    bySelf: "0xa - self - e0",
    midRefund: "0xa u1 chain - e0",
    staleClaim: "0xa u1 chain - e0",
    unclaimed: "0xa u1 - - e1",
    staleUnclaim: "0xa u1 chain - e0",
    refundSubmitted: "0xa u1 chain 0xr e0",
    refunded: "0xa - - 0xs refunded e0",
    refundDropped: "0xa u1 chain - e0",
    migrated: "0xa u1 chain - e0",
  },
  claimedSelf: {
    sent: "0xa - self - e0",
    sentOther: "0xa - self - e0",
    funded: "0xa - self - e0",
    byChain: "0xa - self - e0",
    bySelf: "0xa - self - e0",
    midRefund: "0xa - self - e0",
    staleClaim: "0xa - self - e0",
    unclaimed: "0xa - - - e1",
    staleUnclaim: "0xa - self - e0",
    refundSubmitted: "0xa - self 0xr e0",
    refunded: "0xa - - 0xs refunded e0",
    refundDropped: "0xa - self - e0",
    migrated: "0xa - self - e0",
  },
  refunding: {
    sent: "0xa u1 - 0xr e0",
    sentOther: "0xa u1 - 0xr e0",
    funded: "0xa u2 - 0xr e0",
    byChain: "0xa u1 - 0xr e0",
    bySelf: "0xa u1 - 0xr e0",
    midRefund: "0xa u1 - 0xr e0",
    staleClaim: "0xa u1 - 0xr e0",
    unclaimed: "0xa u1 - 0xr e0",
    staleUnclaim: "0xa u1 - 0xr e0",
    refundSubmitted: "0xa u1 - 0xr e0",
    refunded: "0xa - - 0xs refunded e0",
    refundDropped: "0xa u1 - - e0",
    migrated: "0xa u1 - 0xr migrated e0",
  },
  refunded: Object.fromEntries(Object.keys(EVENTS).map((e) => [e, "0xa - - 0xr refunded e0"])),
  migrated: Object.fromEntries(Object.keys(EVENTS).map((e) => [e, "0xa u1 - - migrated e0"])),
}

describe("paylinkTransition", () => {
  const cells = Object.entries(TABLE).flatMap(([state, row]) =>
    Object.entries(row).map(([event, after]) => [state, event, after] as const),
  )

  it("covers every event from every state", () => {
    expect(cells).toHaveLength(Object.keys(STATES).length * Object.keys(EVENTS).length)
  })

  it.each(cells)("%s + %s", (state, event, after) => {
    const link = { ...base, ...STATES[state] }
    const next = paylinkTransition(link, EVENTS[event]!)
    expect(summary(next ?? link)).toBe(after)
  })

  it("keeps the first claim's time when this account claims a link the chain showed claimed", () => {
    const link = { ...base, ...STATES.claimed }
    expect(paylinkTransition(link, EVENTS.bySelf!)?.claimedAt).toBe(5)
  })

  it("lets a claim through at the epoch an unclaim moved the link to", () => {
    const unclaimed = paylinkTransition({ ...base, ...STATES.claimed }, EVENTS.unclaimed!)!
    const at = { type: "claimed", at: 9, epoch: 1, refundInFlight: false, by: "chain" } as const
    expect(paylinkTransition(unclaimed, EVENTS.byChain!)).toBeUndefined()
    expect(paylinkTransition(unclaimed, at)?.isClaimed).toBe(true)
  })

  it("records the refund's kind, keeps it once refunded, and clears it when the refund drops", () => {
    const funded = { ...base, ...STATES.funded }
    const submitted = paylinkTransition(funded, EVENTS.refundSubmitted!)!
    expect(submitted.refundKind).toBe("cancel")
    expect(paylinkTransition(submitted, EVENTS.refunded!)?.refundKind).toBe("cancel")
    expect(paylinkTransition(submitted, EVENTS.refundDropped!)?.refundKind).toBeUndefined()
  })

  it("stamps a first claim with the time the event saw it", () => {
    expect(paylinkTransition({ ...base, ...STATES.funded }, EVENTS.byChain!)?.claimedAt).toBe(9)
  })
})
