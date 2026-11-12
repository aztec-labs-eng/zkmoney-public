import { L1_SETTLED_DEPTH } from "@obsidion/core/constants"
import { describe, expect, it } from "vitest"
import type { WithdrawalRecord } from "../../src/core/services/bridge/types"
import {
  BACKUP_ADD_DELAYED_AFTER_MS,
  BACKUP_ADD_TAKES_MS,
  backupAddCharged,
  backupAddEta,
  backupAddFees,
  backupAddMoved,
  backupAddTakesMs,
  backupAddTiming,
  waitsOnGas,
  type BackupAddRelease,
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

  it("is delayed once past the quoted time by the grace, counted from the latest funding", () => {
    const resent = [
      funding({ sentAt: 0, outcome: "dead" }),
      funding({ sentAt }),
      funding({ sentAt: sentAt + MIN, txHash: undefined, outcome: "never-sent" }),
    ]
    const late = sentAt + takesMs + BACKUP_ADD_DELAYED_AFTER_MS
    expect(backupAddTiming(paid({ fundings: resent }), late - 1)).toEqual({ delayed: false })
    expect(backupAddTiming(paid({ fundings: resent }), late)).toEqual({ delayed: true })
  })

  it("is delayed when the route stopped paying after it paid", () => {
    const parked = paid({ phase: "attention", attention: "route", suspended: "swept" })
    expect(backupAddTiming(parked, sentAt)?.delayed).toBe(true)
  })

  it("takes the default time for a plan saved without one", () => {
    const late = sentAt + BACKUP_ADD_TAKES_MS + BACKUP_ADD_DELAYED_AFTER_MS
    expect(backupAddTiming(paid({ plan: PLAN }), late - 1)?.delayed).toBe(false)
    expect(backupAddTiming(paid({ plan: PLAN }), late)?.delayed).toBe(true)
  })

  it("has none before paying, or once the add waits on the user rather than the chain", () => {
    expect(backupAddTiming(paid({ phase: "published" }), sentAt)).toBeUndefined()
    expect(backupAddTiming(paid({ phase: "rerooted" }), sentAt)).toBeUndefined()
    const beforePaying = paid({ phase: "attention", attention: "route", suspended: "published" })
    expect(backupAddTiming(beforePaying, sentAt)).toBeUndefined()
    expect(backupAddTiming(paid({ phase: "installed", fundings: [] }), sentAt)).toBeUndefined()
  })
})

describe("backupAddEta", () => {
  const NOW = 1_700_000_000_000
  const release: BackupAddRelease = {
    landingSeconds: 120,
    standardEtaSeconds: 600,
    tippedEtaSeconds: 180,
    l1SlotSeconds: 12,
  }
  const settle = Number(L1_SETTLED_DEPTH) * release.l1SlotSeconds
  /** A relayer step: two Ethereum slots. */
  const pickup = 2 * release.l1SlotSeconds
  /** The relayer's release and sweep, then the sweep settled. */
  const tail = 2 * pickup + settle
  const paid = signedRecord("funded")
  const row = (phase: WithdrawalRecord["phase"], extra: Partial<WithdrawalRecord> = {}) =>
    ({ phase, startTime: NOW - 20 * MIN, ...extra } as WithdrawalRecord)
  const standard = { tipped: false }
  const faster = { tipped: true }

  it("gives the typical wait from now before the funding lands, by the speed asked", () => {
    expect(backupAddEta(undefined, undefined, release, NOW, standard)).toEqual({
      seconds: 120 + 600 + tail,
      remaining: false,
    })
    expect(backupAddEta(undefined, undefined, release, NOW, faster)).toEqual({
      seconds: 120 + 180 + tail,
      remaining: false,
    })
  })

  it("lets the row's own tip pick the release once there is a row", () => {
    const sending = row("submitting", { proverTip: "5" })
    expect(backupAddEta(paid, sending, release, NOW, standard)?.seconds).toBe(120 + 180 + tail)
    const untipped = row("awaiting_proven", { minedAt: NOW - 4 * MIN })
    const tipped = row("awaiting_proven", { minedAt: NOW - 4 * MIN, proverTip: "5" })
    expect(backupAddEta(paid, untipped, release, NOW, faster)?.seconds).toBe(
      (NOW - 4 * MIN) / 1000 + 600 + tail - NOW / 1000,
    )
    expect(backupAddEta(paid, tipped, release, NOW, standard)?.seconds).toBe(
      (NOW - 4 * MIN) / 1000 + 180 + tail - NOW / 1000,
    )
  })

  it.each([
    ["l2_mined", { minedAt: NOW - 4 * MIN, phaseEnteredAt: NOW - MIN }],
    ["awaiting_proven", { minedAt: NOW - 4 * MIN, phaseEnteredAt: NOW - MIN }],
    ["awaiting_proven", { startTime: NOW - 4 * MIN, rebuilt: true }],
  ] as const)(
    "counts down from a %s row's landing, by minedAt or a rebuilt startTime, not the phase entry",
    (phase, extra) => {
      expect(backupAddEta(paid, row(phase, extra), release, NOW, standard)).toEqual({
        seconds: (NOW - 4 * MIN) / 1000 + 600 + tail - NOW / 1000,
        remaining: true,
      })
    },
  )

  it("counts down from the burn's block time once read, not the device's later sighting", () => {
    const seenLate = row("awaiting_proven", { minedAt: NOW - MIN })
    const landed = { ...release, landingSeconds: 0, landedAt: (NOW - 4 * MIN) / 1000 }
    expect(backupAddEta(paid, seenLate, landed, NOW, standard)?.seconds).toBe(
      (NOW - 4 * MIN) / 1000 + 600 + tail - NOW / 1000,
    )
  })

  it("counts the tail from the proof's sighting, and the sweep and settle from the release", () => {
    const provenAt = NOW - 30_000
    const proven = row("finalizing_l1", { minedAt: NOW - 10 * MIN, phaseEnteredAt: provenAt })
    expect(backupAddEta(paid, proven, release, NOW, standard)).toEqual({
      seconds: provenAt / 1000 + tail - NOW / 1000,
      remaining: true,
    })
    const releasedAt = NOW - 10_000
    const released = row("done", { phaseEnteredAt: NOW - 3 * MIN, endTime: releasedAt })
    expect(backupAddEta(paid, released, release, NOW, standard)).toEqual({
      seconds: releasedAt / 1000 + pickup + settle - NOW / 1000,
      remaining: true,
    })
  })

  it("is a countdown at zero once run out or once the sweep is seen", () => {
    const zero = { seconds: 0, remaining: true }
    const longAgo = row("awaiting_proven", { minedAt: NOW - 60 * MIN })
    expect(backupAddEta(paid, longAgo, release, NOW, standard)).toEqual(zero)
    const swept = signedRecord("swept")
    expect(backupAddEta(swept, row("done", { endTime: NOW }), release, NOW, standard)).toEqual(zero)
    expect(backupAddEta(signedRecord("installed"), undefined, release, NOW, standard)).toEqual(zero)
    const parked = signedRecord("attention", { attention: "route", suspended: "swept" })
    expect(backupAddEta(parked, row("done", { endTime: NOW }), release, NOW, standard)).toEqual(
      zero,
    )
  })

  it("has nothing for a failed burn or a phase the add never passes through", () => {
    expect(backupAddEta(paid, row("failed"), release, NOW, standard)).toBeUndefined()
    expect(backupAddEta(paid, row("swapping"), release, NOW, standard)).toBeUndefined()
  })

  it("counts the relayer steps and the settled depth in slots of the length given", () => {
    const narrow = backupAddEta(undefined, undefined, release, NOW, standard)!.seconds
    const wide = backupAddEta(
      undefined,
      undefined,
      { ...release, l1SlotSeconds: 24 },
      NOW,
      standard,
    )!.seconds
    // Twice the slot adds the tail once more: two relayer steps of two slots, then the depth.
    expect(wide - narrow).toBe((2 * 2 + Number(L1_SETTLED_DEPTH)) * 12)
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
