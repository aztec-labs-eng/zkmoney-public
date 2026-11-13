// @vitest-environment node
import { describe, expect, it } from "vitest"
import type { Hash, Hex } from "viem"
import { moveTransition } from "../../src/engine/moveTransition"
import type {
  BuiltMove,
  MoveEvent,
  MovePhase,
  MoveRecord,
  ReplayedMove,
} from "../../src/engine/moveTransition"

const NOW = 5_000
const TX = `0x${"de".repeat(32)}` as Hash
const TO = `0x${"42".repeat(20)}` as const
const DEPOSIT = { inboxIndex: 3n, amount: 98n, messageKey: `0x${"4d".repeat(32)}` as Hex, at: 1 }

const built: BuiltMove = {
  id: "wdraw_a",
  holdingId: "sky",
  rail: "skyEscrow",
  escrow: { factory: `0x${"fa".repeat(20)}`, address: `0x${"e5".repeat(20)}`, tip: 1n },
  direction: "in",
  amount: 100n,
  quote: {
    routed: 98n,
    relayerTip: 2n,
    conversionOut: 98n,
    conversionMinOut: 97n,
    expectedOut: 96n,
    minOut: 95n,
    withdrawalFee: 0n,
  },
  withdrawalLocalId: "wdraw_a",
  nonce: `0x${"01".repeat(32)}`,
  recipientCommitment: `0x${"0c".repeat(32)}`,
  scanFrom: 7n,
  startTime: 1_000,
}
const record = (phase: MovePhase): MoveRecord => ({ ...built, phase })

type Changing = Exclude<MoveEvent["type"], "built" | "replayed" | "migrated">
const EVENTS: Record<Changing, MoveEvent> = {
  burnMined: { type: "burnMined" },
  released: { type: "released", txHash: TX },
  releaseSeen: { type: "releaseSeen", txHash: TX, at: NOW },
  scanned: { type: "scanned", to: 9n },
  depositSeen: { type: "depositSeen", txHash: TX, deposit: DEPOSIT },
  claimed: { type: "claimed", at: NOW },
  observed: { type: "observed", limits: { maxDeposit: 1n, maxRedeem: 1n }, at: NOW },
  failed: { type: "failed", failure: { code: "withdrawal.dropped" }, at: NOW },
  recovered: { type: "recovered", txHash: TX, to: TO, at: NOW },
  dropped: { type: "dropped", at: NOW },
}

/** The phase an event leaves a record in; `null` where it changes nothing. */
const CASES: [Changing, MovePhase, MovePhase | null][] = [
  ["burnMined", "burning", "burned"],
  ["burnMined", "burned", null],
  ["burnMined", "depositSeen", null],
  ["released", "burned", "released"],
  ["released", "released", null],
  ["released", "depositSeen", null],
  ["scanned", "depositSeen", null],
  ["scanned", "claimed", null],
  ["scanned", "failed", null],
  ["scanned", "recovered", null],
  ["scanned", "migrated", null],
  ["depositSeen", "burning", "depositSeen"],
  ["depositSeen", "depositSeen", null],
  ["claimed", "released", null],
  ["claimed", "depositSeen", "claimed"],
  ["observed", "released", null],
  ["observed", "depositSeen", null],
  ["failed", "burning", "failed"],
  ["failed", "released", null],
  ["failed", "depositSeen", null],
  ["recovered", "burning", "recovered"],
  ["recovered", "released", null],
  ["recovered", "depositSeen", null],
  // An old version's refund returns a migrated move's funds; nothing else moves it.
  ["recovered", "migrated", "recovered"],
  ["claimed", "migrated", null],
  ["dropped", "burned", null],
]

describe("moveTransition", () => {
  it.each(CASES)("%s on %s → %s", (event, phase, expected) => {
    expect(moveTransition(record(phase), EVENTS[event])?.phase ?? null).toBe(expected)
  })

  it("makes no record from an event that only changes one", () => {
    expect(moveTransition(undefined, EVENTS.burnMined)).toBeUndefined()
  })

  it("keeps the quote's figures and the limits, not what else the reads returned", () => {
    const quote = { ...built.quote, gasUsed: 9n }
    const created = moveTransition(undefined, { type: "built", record: { ...built, quote } })
    expect(created?.quote).toEqual(built.quote)
    const limits = { maxDeposit: 1n, maxRedeem: 2n, asOf: 4n }
    const seen = moveTransition(record("burned"), { type: "observed", limits, at: NOW })
    expect(seen?.observed).toEqual({ at: NOW, maxDeposit: 1n, maxRedeem: 2n })
  })

  it("creates a replayed record in the phase the chain shows, and never over one", () => {
    const { quote: _quote, withdrawalLocalId: _local, ...facts } = built
    const replayed: ReplayedMove = {
      ...facts,
      id: "replayed-0x0b",
      phase: "released",
      withdrawalId: `0x${"77".repeat(32)}`,
      replayedFrom: "0x0b",
    }
    const event = { type: "replayed", record: replayed } as const
    expect(moveTransition(undefined, event)).toEqual(replayed)
    expect(moveTransition(record("burned"), event)).toBeUndefined()
  })

  it("keeps the newest limits when an older read lands after a newer one", () => {
    const read = (at: number, maxRedeem: bigint) =>
      ({ type: "observed", limits: { maxDeposit: 1n, maxRedeem }, at } as const)
    const newer = moveTransition(record("burned"), read(NOW, 5n))
    expect(moveTransition(newer, read(NOW - 1, 0n))).toBeUndefined()
    expect(moveTransition(newer, read(NOW, 0n))).toBeUndefined()
    expect(moveTransition(newer, read(NOW + 1, 0n))?.observed?.maxRedeem).toBe(0n)
  })

  it("times a release once, before the route runs, and keeps its tx when the run names none", () => {
    const seen = moveTransition(record("burned"), EVENTS.releaseSeen)
    expect(seen).toMatchObject({ phase: "burned", releasedAt: NOW, l1: { releaseTx: TX } })
    expect(moveTransition(seen, { type: "releaseSeen", txHash: TX, at: NOW + 1 })).toBeUndefined()
    expect(moveTransition(record("released"), EVENTS.releaseSeen)).toBeUndefined()
    expect(moveTransition(seen, { type: "released" })?.l1?.releaseTx).toBe(TX)
  })

  it("moves the search cursor forward only", () => {
    const scanned = moveTransition(record("released"), EVENTS.scanned)
    expect(scanned?.scannedTo).toBe(9n)
    expect(moveTransition(scanned, { type: "scanned", to: 9n })).toBeUndefined()
    expect(moveTransition(scanned, { type: "scanned", to: 8n })).toBeUndefined()
    expect(moveTransition(scanned, { type: "scanned", to: 10n })?.scannedTo).toBe(10n)
  })

  it("records no release tx for a release that names none, and the vault's figure it carries", () => {
    expect(moveTransition(record("burned"), { type: "released" })?.l1).toBeUndefined()
    const released = moveTransition(record("burned"), { type: "released", assets: 97n })
    expect(released?.assets).toBe(97n)
  })

  it("keeps a seen deposit's release tx, or takes the deposit's on the executor rail", () => {
    const deposited = `0x${"d0".repeat(32)}` as Hash
    const event = { type: "depositSeen", txHash: deposited, deposit: DEPOSIT } as const
    const released = moveTransition(record("burned"), EVENTS.released)
    expect(moveTransition(released, event)).toMatchObject({
      deposit: DEPOSIT,
      l1: { releaseTx: TX, depositTx: deposited },
    })
    const executor: MoveRecord = { ...built, rail: "executor", phase: "burned" }
    expect(moveTransition(executor, event)?.l1).toEqual({
      releaseTx: deposited,
      depositTx: deposited,
    })
    expect(moveTransition(record("burned"), event)?.l1).toEqual({ depositTx: deposited })
  })

  it("stamps the end of a terminal phase with the event's time", () => {
    const seen = moveTransition(record("released"), EVENTS.depositSeen)
    expect(moveTransition(seen, EVENTS.claimed)?.endTime).toBe(NOW)
    expect(moveTransition(record("burned"), EVENTS.recovered)).toMatchObject({
      recoveredTo: TO,
      l1: { recoveryTx: TX },
      endTime: NOW,
    })
    expect(moveTransition(record("burning"), EVENTS.failed)).toMatchObject({
      failure: { code: "withdrawal.dropped" },
      endTime: NOW,
    })
    expect(moveTransition(record("burning"), EVENTS.dropped)?.endTime).toBe(NOW)
  })

  it("keeps a migrated record's quote figures only, and adds no quote to one without", () => {
    const quote = { ...built.quote, gasUsed: 9n }
    const migrated = (r: MoveRecord) =>
      moveTransition(undefined, { type: "migrated", record: r, at: NOW })
    expect(migrated({ ...record("burned"), quote })?.quote).toEqual(built.quote)
    const { quote: _quote, ...quoteless } = record("burned")
    expect(migrated(quoteless)).not.toHaveProperty("quote")
  })

  /** What a retired rollup's record becomes here: an open move, a settled one, a migrated one. */
  const MIGRATED: [MovePhase, Pick<MoveRecord, "phase" | "endTime">][] = [
    ["burning", { phase: "migrated", endTime: NOW }],
    ["claimed", { phase: "claimed", endTime: undefined }],
    ["migrated", { phase: "migrated", endTime: NOW }],
  ]
  it.each(MIGRATED)("migrated from %s creates a record, and never over one", (phase, expected) => {
    const event = { type: "migrated", record: record(phase), at: NOW } as const
    const created = moveTransition(undefined, event)
    expect({ phase: created?.phase, endTime: created?.endTime }).toEqual(expected)
    expect(moveTransition(record("burning"), event)).toBeUndefined()
  })
})
