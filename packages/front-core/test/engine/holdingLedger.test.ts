// @vitest-environment node
import { describe, expect, it } from "vitest"
import type { WithdrawalRecord } from "../../src/core/services/bridge/types"
import {
  holdingEarned,
  holdingEarnedPending,
  holdingLedger,
  shareDust,
} from "../../src/engine/holdingLedger"
import type { LedgerMove } from "../../src/engine/holdingLedger"

const ONE = 10n ** 18n
/** Shares at a 1.07 share price: what `usds` buys. */
const sharesFor = (usds: bigint) => (usds * 100n) / 107n

/** One Sky move. `at`: when a move in's deposit landed, or a move out's burn mined. */
interface Step {
  direction: "in" | "out"
  /** Moving in, the shares that landed; moving out, the shares burned. */
  shares: bigint
  /** The USDS a move in put into the vault. */
  cost?: bigint
  /** A move in's claim, or a move out's burn. */
  state: "claimed" | "unclaimed" | "mined" | "sent" | "proving" | "failed"
  startTime: number
  at?: number
}

const into = (cost: bigint, shares: bigint, over: Partial<Step> = {}): Step => ({
  direction: "in",
  shares,
  cost,
  state: "claimed",
  startTime: 0,
  ...over,
})
const outOf = (shares: bigint, over: Partial<Step> = {}): Step => ({
  direction: "out",
  shares,
  state: "mined",
  startTime: 0,
  ...over,
})

const BURN_PHASE = { mined: "done", sent: "submitting", proving: "submitting", failed: "failed" }

function burnsOf(steps: readonly Step[]): Map<string, WithdrawalRecord> {
  return new Map(
    steps.flatMap((step, i) =>
      step.direction === "out"
        ? [
            [
              `w${i}`,
              {
                localId: `w${i}`,
                phase: BURN_PHASE[step.state as keyof typeof BURN_PHASE],
                startTime: step.startTime,
                ...(step.at === undefined ? {} : { minedAt: step.at }),
                ...(step.state === "sent" ? { l2TxHash: "0x5e" } : {}),
              } as WithdrawalRecord,
            ] as const,
          ]
        : [],
    ),
  )
}

const ledgerMove = (step: Step, i: number): LedgerMove => ({
  id: `m${i}`,
  holdingId: "fea-sky-v6",
  direction: step.direction,
  amount: step.direction === "in" ? step.cost! + 3n * ONE : step.shares,
  phase:
    step.direction === "out"
      ? step.state === "mined"
        ? "burned"
        : "burning"
      : step.state === "claimed"
      ? "claimed"
      : "depositSeen",
  withdrawalLocalId: `w${i}`,
  startTime: step.startTime,
  ...(step.direction === "in"
    ? {
        quote: { conversionOut: step.cost! },
        deposit: { amount: step.shares, at: step.at ?? step.startTime },
      }
    : {}),
})

/** The ledger and earned figure for `steps`. */
function figuresOf(steps: readonly Step[], value: bigint, held: bigint) {
  const holding = holdingLedger(steps.map(ledgerMove), burnsOf(steps))
  return {
    basis: holding.basis,
    shares: holding.shares,
    counted: holding.counted,
    excluded: holding.excluded.length,
    earned: holdingEarned(holding, value, held, 18),
    pending: holdingEarnedPending(holding),
  }
}

const HELD = sharesFor(107n * ONE)
const IN = into(107n * ONE, HELD)

type Figures = Partial<ReturnType<typeof figuresOf>>

describe("holdingLedger: Sky's moves", () => {
  it.each<{ case: string; steps: Step[]; reads: [value: bigint, held: bigint, Figures][] }>([
    {
      case: "in only: earnings are the value above what was put in, a loss below zero",
      steps: [IN],
      reads: [
        [110n * ONE, HELD, { basis: 107n * ONE, earned: 3n * ONE }],
        [107n * ONE + 1n, HELD, { earned: 1n }],
        [100n * ONE, HELD, { earned: -7n * ONE }],
      ],
    },
    {
      case: "a full move out leaves nothing to earn on",
      steps: [IN, outOf(HELD)],
      reads: [[0n, 0n, { basis: 0n, shares: 0n, counted: 2, earned: 0n }]],
    },
    {
      // A move out mined before a top-up landed takes none of the top-up's cost.
      case: "replays in the order shares moved, whatever order the store lists them",
      steps: [
        into(60n * ONE, 50n * ONE, { startTime: 1, at: 300 }),
        outOf(50n * ONE, { startTime: 2, at: 200 }),
        into(100n * ONE, 100n * ONE, { at: 100 }),
      ],
      reads: [[110n * ONE, 100n * ONE, { basis: 110n * ONE, shares: 100n * ONE }]],
    },
    {
      case: "counts neither a failed or unsent burn nor an unclaimed move in",
      steps: [
        IN,
        outOf(40n * ONE, { state: "failed" }),
        outOf(10n * ONE, { state: "proving" }),
        into(10n * ONE, 9n * ONE, { state: "unclaimed" }),
      ],
      reads: [[108n * ONE, HELD, { basis: 107n * ONE, counted: 1, earned: ONE }]],
    },
    {
      case: "waits on a burn sent but not yet mined rather than read a loss",
      steps: [IN, outOf(40n * ONE, { state: "sent" })],
      reads: [[70n * ONE, HELD - 40n * ONE, { excluded: 1, earned: undefined, pending: true }]],
    },
    {
      case: "reads the shares held within dust of the replay, and no figure beyond it",
      steps: [IN],
      reads: [
        [108n * ONE, HELD + 3n, { earned: ONE }],
        [108n * ONE, HELD - 3n, { earned: ONE }],
        // Shares no move accounts for, as on a fresh device: they would read as earnings.
        [216n * ONE, 2n * HELD, { earned: undefined }],
      ],
    },
  ])("$case", ({ steps, reads }) => {
    for (const [value, held, figures] of reads)
      expect(figuresOf(steps, value, held)).toMatchObject(figures)
  })
})

describe("holdingLedger", () => {
  const replayedIn: LedgerMove = {
    id: "r",
    holdingId: "fea-sky-v6",
    direction: "in",
    amount: 260n * ONE,
    phase: "claimed",
    deposit: { amount: 240n * ONE, at: 1 },
    startTime: 0,
  }

  it("leaves the figure unknown for good after a claimed move in with no quote, burns pending or not", () => {
    const sent: LedgerMove = {
      id: "o",
      holdingId: "fea-sky-v6",
      direction: "out",
      amount: 40n * ONE,
      phase: "burning",
      withdrawalLocalId: "w",
      startTime: 2,
    }
    const burns = new Map([["w", { phase: "submitting", l2TxHash: "0x5e", startTime: 2 } as const]])
    const ledger = holdingLedger([replayedIn, sent], burns)
    expect(ledger.excluded).toEqual([
      { moveId: "r", reason: "noCost" },
      { moveId: "o", reason: "burnUnmined" },
    ])
    expect(holdingEarned(ledger, 260n * ONE, 240n * ONE, 18)).toBeUndefined()
    expect(holdingEarnedPending(ledger)).toBe(false)
  })

  it("replays a move out with no burn record as mined, in time order", () => {
    const out: LedgerMove = {
      id: "o",
      holdingId: "fea-sky-v6",
      direction: "out",
      amount: 60n * ONE,
      phase: "burned",
      startTime: 2,
    }
    const ledger = holdingLedger(
      [out, { ...replayedIn, quote: { conversionOut: 250n * ONE } }],
      new Map(),
    )
    expect(ledger).toMatchObject({ counted: 2, shares: 180n * ONE, basis: (250n * ONE * 3n) / 4n })
    expect(holdingEarned(ledger, 200n * ONE, 180n * ONE, 18)).toBe(200n * ONE - (750n * ONE) / 4n)
  })

  it("prices a move in at the vault's figure over its quote's, and never counts a dropped move", () => {
    const dropped: LedgerMove = {
      id: "d",
      holdingId: "fea-sky-v6",
      direction: "out",
      amount: 60n * ONE,
      phase: "dropped",
      withdrawalLocalId: "gone",
      startTime: 2,
    }
    const priced = { ...replayedIn, assets: 245n * ONE, quote: { conversionOut: 250n * ONE } }
    const ledger = holdingLedger([priced, dropped], new Map())
    expect(ledger).toMatchObject({ counted: 1, shares: 240n * ONE, basis: 245n * ONE })
  })

  it("keeps a vault of a 6-decimal asset's cost and earnings in that asset, not the base's 18", () => {
    // 800 DAI in through a Psm: the vault took 799.37 USDC for 760 shares.
    const usdc = (cents: bigint) => cents * 10_000n
    const psmIn: LedgerMove = {
      id: "p",
      holdingId: "fea-vault",
      direction: "in",
      amount: 800n * ONE,
      phase: "claimed",
      assets: usdc(79_937n),
      quote: { conversionOut: usdc(79_940n) },
      deposit: { amount: 760n * ONE, at: 1 },
      startTime: 0,
    }
    const half: LedgerMove = {
      ...psmIn,
      id: "o",
      direction: "out",
      amount: 380n * ONE,
      phase: "burned",
      startTime: 2,
    }
    const ledger = holdingLedger([psmIn, half], new Map())
    expect(ledger).toMatchObject({ counted: 2, shares: 380n * ONE, basis: usdc(79_937n) / 2n })
    // The 380 shares left redeem 402.80 USDC.
    expect(holdingEarned(ledger, usdc(40_280n), 380n * ONE, 18)).toBe(
      usdc(40_280n) - usdc(79_937n) / 2n,
    )
  })

  it("takes a millionth of a share as dust, whatever the share's decimals", () => {
    expect(shareDust(18)).toBe(10n ** 12n)
    expect(shareDust(6)).toBe(1n)
  })
})
