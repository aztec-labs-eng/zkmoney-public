// @vitest-environment node
import type { WithdrawalRecord } from "@obsidion/front-core"
import type { FundingAmount, SpendShape } from "@obsidion/sdk"
import { describe, expect, it } from "vitest"
import {
  chainFacts,
  savingsMoving,
  withdrawalInFlight,
} from "../../../src/features/backupPasskey/backupPasskeyFacts"
import { moveRecord as move } from "../../support/moves"

const DAI = 10n ** 18n
const funding = (amount: bigint): FundingAmount =>
  ({ amount, credited: amount / 2n, breakdown: { sweepTip: amount / 4n } } as FundingAmount)
const shape = (notes: bigint[], depositTotal = 0n): SpendShape => ({
  notes,
  depositTotal,
  balance: notes.reduce((a, b) => a + b, 0n) + depositTotal,
})

describe("chainFacts", () => {
  it("names a route that is not live, with nothing to fund", () => {
    const facts = chainFacts({
      funding: undefined,
      shape: shape([3n * DAI]),
      cap: 5n * DAI,
    })
    expect(facts).toMatchObject({ routeLive: false, fundingAmount: 0n, chunk: { kind: "fits" } })
    expect(facts.quote).toBeUndefined()
  })

  it("quotes what the add costs and takes, before it starts", () => {
    const facts = chainFacts({
      funding: funding(4n * DAI),
      shape: shape([10n * DAI]),
      cap: 5n * DAI,
    })
    expect(facts.quote).toEqual({ total: 2n * DAI, fixed: DAI, network: DAI })
  })

  it("says the funding comes back in part, and whether one transfer funds a tip on top", () => {
    // Main Account holds one 3 DAI note: one transfer funds up to it, not a unit more.
    const facts = chainFacts({
      funding: funding(2n * DAI),
      shape: shape([3n * DAI]),
      cap: 5n * DAI,
    })
    expect(facts.credited).toBe(DAI)
    expect(facts.fits(3n * DAI)).toBe(true)
    expect(facts.fits(3n * DAI + 1n)).toBe(false)
  })

  it("has no plan over a cap of nothing", () => {
    const facts = chainFacts({
      funding: funding(DAI),
      shape: shape([3n * DAI]),
      cap: 0n,
    })
    expect(facts).toMatchObject({ plan: false, moves: 0 })
  })

  const main = { funding: funding(DAI), shape: shape([3n * DAI]), cap: 2n * DAI }

  it("counts the Savings shares' sends beside Main Account's, each cut to its own cap", () => {
    const facts = chainFacts({ ...main, others: [{ shape: shape([5n * DAI]), cap: 4n * DAI }] })
    expect(facts).toMatchObject({ plan: true, moves: 4, balance: 3n * DAI })
  })

  it("counts Savings shares alone when Main Account holds nothing", () => {
    const savings = { shape: shape([DAI]), cap: 4n * DAI }
    const facts = chainFacts({ ...main, shape: shape([]), others: [savings] })
    expect(facts).toMatchObject({ plan: true, moves: 1, balance: 0n })
  })

  it("moves dust shares in one send rather than leaving them behind", () => {
    const facts = chainFacts({ ...main, others: [{ shape: shape([1n]), cap: 4n * DAI }] })
    expect(facts).toMatchObject({ plan: true, moves: 3 })
  })

  it("counts the open paylinks' refunds into Main Account's move, as notes", () => {
    const facts = chainFacts({ ...main, refunds: [DAI, 2n * DAI, 0n] })
    // 3 DAI held and 3 DAI refunded, cut at 2 DAI.
    expect(facts).toMatchObject({ plan: true, moves: 3, balance: 3n * DAI })
  })

  it("has no plan when a Savings cap is nothing", () => {
    const facts = chainFacts({ ...main, others: [{ shape: shape([DAI]), cap: 0n }] })
    expect(facts.plan).toBe(false)
  })
})

describe("withdrawalInFlight", () => {
  it("counts a withdrawal in any phase but the settled ones", () => {
    expect(
      withdrawalInFlight([{ phase: "done" }, { phase: "failed" }, { phase: "recovered" }]),
    ).toBe(false)
    expect(withdrawalInFlight([{ phase: "done" }, { phase: "finalizing_l1" }])).toBe(true)
    expect(withdrawalInFlight([])).toBe(false)
  })
})

describe("savingsMoving", () => {
  it("counts a move until it settles", () => {
    expect(savingsMoving([move()], [])).toBe(true)
    expect(savingsMoving([move({ phase: "depositSeen" })], [])).toBe(true)
    expect(savingsMoving([move({ phase: "claimed" })], [])).toBe(false)
    expect(savingsMoving([move({ phase: "recovered" })], [])).toBe(false)
  })

  it("leaves out a move whose burn failed or never went out, and a retired one", () => {
    expect(savingsMoving([move({ phase: "failed" })], [])).toBe(false)
    expect(savingsMoving([move({ phase: "dropped" })], [])).toBe(false)
    expect(savingsMoving([move({ phase: "migrated" })], [])).toBe(false)
  })

  // The burn's hash in another case than the move's copy of it.
  const l2TxHash = "0xAB" as WithdrawalRecord["l2TxHash"]
  const burn = (phase: WithdrawalRecord["phase"]) =>
    ({ localId: "w1", l2TxHash, phase } as WithdrawalRecord)

  it.each([
    ["Sky", { skyMove: { direction: "in" } }],
    ["vault", { vaultMove: { holdingId: "fea-vault", nonce: "0x01" } }],
  ])("counts a %s move's burn until a move carries it", (_rail, marker) => {
    const rebuilt = { ...burn("done"), ...marker } as WithdrawalRecord
    expect(savingsMoving([], [rebuilt])).toBe(true)
    expect(savingsMoving([], [{ ...rebuilt, phase: "failed" }])).toBe(false)
    expect(savingsMoving([move({ phase: "claimed" })], [rebuilt])).toBe(false)
    const replayed = move({ phase: "claimed", withdrawalLocalId: undefined, replayedFrom: "0xab" })
    expect(savingsMoving([replayed], [rebuilt])).toBe(false)
    // A plain withdrawal is no Savings move.
    expect(savingsMoving([], [burn("done")])).toBe(false)
  })
})
