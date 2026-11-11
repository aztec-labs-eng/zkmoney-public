import { describe, expect, it } from "vitest"
import {
  BACKUP_ADD_DELAYED_AFTER_MS,
  BACKUP_ADD_TAKES_MS,
  backupAddCharged,
  backupAddFees,
  backupAddMoved,
  backupAddTakesMs,
  backupAddTiming,
  waitsOnGas,
} from "../../src/engine/backupAddQuote"
import type { MoveChunkRecord } from "../../src/engine/backupRotations"
import { PLAN, funding, signedRecord } from "../__test-helpers__/backupRotation"

const DAI = 10n ** 18n
const cents = (n: bigint) => (n * DAI) / 100n
const MIN = 60_000

describe("backupAddFees", () => {
  it("charges every fee in the funding, splits off the sweep tip, and leaves the credit out", () => {
    const breakdown = {
      withdrawalFee: cents(10n),
      proverTip: cents(5n),
      relayerTip: cents(15n),
      sweepTip: cents(35n),
      beneficiaryFee: cents(5n),
      minCredited: DAI,
      margin: cents(50n),
    }
    const credited = cents(150n)
    const amount = cents(70n) + credited
    expect(backupAddFees({ amount, credited, breakdown })).toEqual({
      total: cents(70n),
      fixed: cents(35n),
      network: cents(35n),
    })
  })
})

describe("backupAddTakesMs", () => {
  it("bounds the burn's landing, a whole epoch, a full proof and Ethereum's settling", () => {
    // 600 s + 32 slots of 36 s + 900 s, then 15 min.
    expect(backupAddTakesMs(600, { epochDuration: 32, slotDuration: 36 }, 900)).toBe(3_552_000)
  })
})

describe("waitsOnGas", () => {
  const parked = (over: Parameters<typeof signedRecord>[1]) =>
    signedRecord("attention", { attention: "route", ...over })

  it("is a route park before any funding goes out, never one after", () => {
    for (const suspended of ["signed", "published"] as const)
      expect(waitsOnGas(parked({ suspended }))).toBe(true)
    expect(waitsOnGas(parked({ suspended: "funded", fundings: [funding()] }))).toBe(false)
    expect(waitsOnGas(parked({ attention: "stranded", suspended: "published" }))).toBe(false)
  })

  it("is not a park over a funding that landed, though its phase is before paying", () => {
    const lost = (["dead", "never-sent", "reverted"] as const).map((outcome) =>
      funding({ outcome }),
    )
    expect(waitsOnGas(parked({ suspended: "published", fundings: lost }))).toBe(true)
    for (const outcome of ["mined", "swept"] as const)
      expect(waitsOnGas(parked({ suspended: "published", fundings: [funding({ outcome })] }))).toBe(
        false,
      )
  })
})

describe("backupAddTiming", () => {
  const sentAt = 1_000_000
  const takesMs = 20 * MIN
  const paid = (over: Parameters<typeof signedRecord>[1] = {}) =>
    signedRecord("funded", {
      plan: { ...PLAN, takesMs },
      fundings: [funding({ sentAt })],
      ...over,
    })

  it("counts down from the latest funding sent, by the plan's quoted time", () => {
    const resent = [
      funding({ sentAt: 0, outcome: "dead" }),
      funding({ sentAt }),
      funding({ sentAt: sentAt + MIN, txHash: undefined, outcome: "never-sent" }),
    ]
    expect(backupAddTiming(paid({ fundings: resent }), sentAt + 5 * MIN)).toEqual({
      leftMs: 15 * MIN,
      delayed: false,
    })
  })

  it("is delayed once past its time by the grace, and when the route stopped paying after it paid", () => {
    const late = sentAt + takesMs + BACKUP_ADD_DELAYED_AFTER_MS
    expect(backupAddTiming(paid(), late - 1)).toMatchObject({ leftMs: 0, delayed: false })
    expect(backupAddTiming(paid(), late)?.delayed).toBe(true)
    const parked = paid({ phase: "attention", attention: "route", suspended: "swept" })
    expect(backupAddTiming(parked, sentAt)?.delayed).toBe(true)
  })

  it("takes the default time for a plan saved without one", () => {
    expect(backupAddTiming(paid({ plan: PLAN }), sentAt)?.leftMs).toBe(BACKUP_ADD_TAKES_MS)
  })

  it("has none before paying, or once the add waits on the user rather than the chain", () => {
    expect(backupAddTiming(paid({ phase: "published" }), sentAt)).toBeUndefined()
    expect(backupAddTiming(paid({ phase: "rerooted" }), sentAt)).toBeUndefined()
    const beforePaying = paid({ phase: "attention", attention: "route", suspended: "published" })
    expect(backupAddTiming(beforePaying, sentAt)).toBeUndefined()
    expect(backupAddTiming(paid({ phase: "installed", fundings: [] }), sentAt)).toBeUndefined()
  })
})

describe("backupAddCharged", () => {
  it("is the plan's funding less its credit, once a funding went out", () => {
    expect(backupAddCharged({ plan: PLAN, fundings: [funding()] })).toBe(600n)
    expect(backupAddCharged({ plan: PLAN, fundings: [funding({ outcome: "swept" })] })).toBe(600n)
  })

  it("is nothing while no funding went out or every one was lost", () => {
    expect(backupAddCharged({ plan: PLAN, fundings: [] })).toBeUndefined()
    const lost = [funding({ outcome: "dead" }), funding({ outcome: "reverted" })]
    expect(backupAddCharged({ plan: PLAN, fundings: lost })).toBeUndefined()
    expect(backupAddCharged({ fundings: [funding()] })).toBeUndefined()
  })
})

describe("backupAddMoved", () => {
  const chunk = (token: string, amount: bigint, over: Partial<MoveChunkRecord> = {}) => ({
    token,
    amount: amount.toString(),
    state: "mined" as const,
    ...over,
  })

  it("sums each token's sends that landed, across runs, leaving out the unsent and the reverted", () => {
    const run = (chunks: MoveChunkRecord[]) => ({ plannedAt: 1, m: 2, depositBound: false, chunks })
    const moved = backupAddMoved({
      move: {
        runs: [
          run([chunk("main", 2n * DAI), chunk("main", DAI, { effect: "reverted" })]),
          run([
            chunk("main", DAI, { state: "included" }),
            chunk("savings", 3n * DAI),
            chunk("main", 5n * DAI, { state: "submitted" }),
          ]),
        ],
      },
    })
    expect([...moved]).toEqual([
      ["main", 3n * DAI],
      ["savings", 3n * DAI],
    ])
    expect(backupAddMoved({}).size).toBe(0)
  })
})
