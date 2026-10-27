import { describe, expect, it } from "vitest"
import type { SpendShape } from "@obsidion/sdk"
import {
  fundingFits,
  moveDeposits,
  planMove,
  provableChunk,
  unreadDeposits,
  type MoveDeposits,
} from "../../../src/core/rotation/planMove"

const DAI = 10n ** 18n
const CAP = 100n * DAI
const sum = (amounts: readonly bigint[]) => amounts.reduce((t, a) => t + a, 0n)
const shape = (notes: bigint[], deposits: bigint[] = []): SpendShape => ({
  notes: [...notes].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0)),
  depositTotal: sum(deposits),
  balance: sum(notes) + sum(deposits),
})
const exact = (amounts: bigint[]): MoveDeposits => ({ kind: "exact", amounts })
const UNKNOWN: MoveDeposits = { kind: "unknown" }
const NONE = exact([])
const amounts = (plan: ReturnType<typeof planMove>) => plan.chunks.map((c) => c.amount)

describe("moveDeposits", () => {
  it("is exact only when the amounts sum to the deposit total", () => {
    expect(moveDeposits({ depositTotal: 3n }, [1n, 2n])).toEqual(exact([1n, 2n]))
    expect(moveDeposits({ depositTotal: 3n }, [1n, 1n])).toEqual(UNKNOWN)
    expect(moveDeposits({ depositTotal: 0n }, undefined)).toEqual(UNKNOWN)
    expect(moveDeposits({ depositTotal: 0n }, [])).toEqual(exact([]))
  })
})

describe("planMove with notes only", () => {
  it("needs exactly ceil(balance / cap) chunks for 18 notes or fewer", () => {
    const notes = Array.from({ length: 18 }, (_, i) => BigInt(i + 1) * 13n * DAI)
    const s = shape(notes)
    const plan = planMove(s, CAP, NONE)
    expect(plan.m).toBe(Number((s.balance + CAP - 1n) / CAP))
    expect(sum(amounts(plan))).toBe(s.balance)
    expect(plan.chunks.every((c) => c.proven && c.amount <= CAP)).toBe(true)
    expect(plan.bound).toBe("exact")
  })

  it("cuts 40 equal notes at 18 notes a chunk", () => {
    const plan = planMove(shape(Array(40).fill(DAI)), CAP, NONE)
    expect(amounts(plan)).toEqual([18n * DAI, 18n * DAI, 4n * DAI])
    expect(plan.bound).toBe("exact")
  })

  it("puts a capped chunk's change back as a note", () => {
    const plan = planMove(shape([150n * DAI]), CAP, NONE)
    expect(amounts(plan)).toEqual([CAP, 50n * DAI])
  })

  it("plans nothing over an empty balance", () => {
    expect(planMove(shape([]), CAP, NONE)).toEqual({ chunks: [], m: 0, bound: "exact" })
  })
})

describe("planMove with an exact deposit set", () => {
  it("moves 10 notes and 5 deposits under the cap in one chunk of the whole balance", () => {
    const s = shape(Array(10).fill(2n * DAI), Array(5).fill(3n * DAI))
    const plan = planMove(s, CAP, exact(Array(5).fill(3n * DAI)))
    expect(amounts(plan)).toEqual([s.balance])
    expect(plan.bound).toBe("exact")
  })

  it("cuts each chunk from the 18 largest notes and the 18 smallest deposits, as an upper bound", () => {
    const notes = Array(30).fill(DAI / 100n)
    const deposits = Array.from({ length: 40 }, (_, i) => BigInt(i + 1) * DAI)
    const s = shape(notes, deposits)
    const plan = planMove(s, 1000n * DAI, exact(deposits))
    const first = sum(notes.slice(0, 18)) + sum(deposits.slice(0, 18))
    expect(plan.chunks[0]!.amount).toBe(first)
    expect(sum(amounts(plan))).toBe(s.balance)
    expect(plan.bound).toBe("upper")
    expect(plan.m).toBe(3)
  })

  it("caps a chunk the deposits would overfill", () => {
    const deposits = [60n * DAI, 70n * DAI]
    const plan = planMove(shape([], deposits), CAP, exact(deposits))
    expect(amounts(plan)).toEqual([CAP, 30n * DAI])
    expect(plan.bound).toBe("upper")
  })
})

describe("planMove with an unknown deposit set", () => {
  it("cuts note-only chunks while the notes cover one, then one attempt of the cap each", () => {
    const notes = Array(20).fill(DAI)
    const s: SpendShape = { notes, depositTotal: 250n * DAI, balance: 270n * DAI }
    const plan = planMove(s, CAP, UNKNOWN)
    expect(plan.chunks.slice(0, 2)).toEqual([
      { amount: 18n * DAI, proven: true },
      { amount: 2n * DAI, proven: true },
    ])
    expect(plan.chunks.slice(2)).toEqual([
      { amount: CAP, proven: false },
      { amount: CAP, proven: false },
      { amount: 50n * DAI, proven: false },
    ])
    expect(plan.bound).toBe("upper")
  })

  it("always makes progress", () => {
    const s: SpendShape = { notes: [], depositTotal: 5n, balance: 5n }
    expect(planMove(s, 2n, UNKNOWN).chunks.map((c) => c.amount)).toEqual([2n, 2n, 1n])
  })
})

describe("the funding preflight", () => {
  const notes = Array(20).fill(DAI)
  const deposits = Array(20).fill(DAI)
  const held = (depositTotal = 0n) => ({ notes, depositTotal })

  it("fits within the 18 largest notes", () => {
    expect(fundingFits(18n * DAI, CAP, held(DAI), UNKNOWN)).toEqual({ kind: "fits" })
    expect(provableChunk(CAP, notes, UNKNOWN)).toBe(18n * DAI)
  })

  it("fits within the notes plus the 18 smallest deposits of an exact set", () => {
    expect(fundingFits(36n * DAI, CAP, held(20n * DAI), exact(deposits))).toEqual({ kind: "fits" })
  })

  it("names the proven chunk when an exact set falls short", () => {
    expect(fundingFits(37n * DAI, CAP, held(20n * DAI), exact(deposits))).toEqual({
      kind: "short",
      chunk: 36n * DAI,
    })
  })

  it("lets an unread set carry what the notes leave while its total covers it", () => {
    expect(fundingFits(19n * DAI, CAP, held(DAI), UNKNOWN)).toEqual({ kind: "fits" })
    expect(fundingFits(5n * DAI, CAP, { notes: [], depositTotal: 5n * DAI }, UNKNOWN)).toEqual({
      kind: "fits",
    })
  })

  it("names the notes' chunk when an unread set's total falls short", () => {
    expect(fundingFits(20n * DAI, CAP, held(DAI), UNKNOWN)).toEqual({
      kind: "short",
      chunk: 18n * DAI,
    })
  })

  it("never fits above the cap", () => {
    expect(fundingFits(CAP + 1n, CAP, { notes: [CAP * 2n], depositTotal: 0n }, NONE)).toEqual({
      kind: "short",
      chunk: CAP,
    })
    expect(fundingFits(CAP + 1n, CAP, { notes: [], depositTotal: CAP * 2n }, UNKNOWN)).toEqual({
      kind: "short",
      chunk: 0n,
    })
  })

  it("knows an unread set is empty while nothing is held in deposits", () => {
    expect(unreadDeposits({ depositTotal: 0n })).toEqual({ kind: "exact", amounts: [] })
    expect(unreadDeposits({ depositTotal: DAI })).toEqual({ kind: "unknown" })
  })
})
