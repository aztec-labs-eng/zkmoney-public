// @vitest-environment node
import type { SavingsMoveRecord, WithdrawalRecord } from "@obsidion/front-core"
import type { FundingAmount, SpendShape } from "@obsidion/sdk"
import { describe, expect, it, vi } from "vitest"

vi.mock("../../../src/features/withdraw/useWithdrawals", () => ({ useWithdrawals: () => ({}) }))
vi.mock("../../../src/features/migration/oldVersionBalance", () => ({
  useOldVersionHoldings: () => ({}),
}))
vi.mock("../../../src/features/migration/upgradeLock", () => ({
  useUpgradeLock: () => ({ state: "pending" }),
}))
vi.mock("../../../src/features/registration/registrationResume", () => ({
  unlockedSessionKeys: () => {},
}))
vi.mock("../../../src/config/classArtifacts", () => ({ getWebOxideToken: () => {} }))
vi.mock("../../../src/config/oxideTuple", () => ({}))
vi.mock("../../../src/features/backupPasskey/backupMoveTokens", async (importOriginal) => ({
  moveCount: (
    await importOriginal<typeof import("../../../src/features/backupPasskey/backupMoveTokens")>()
  ).moveCount,
  readMoveBalances: () => {},
}))
vi.mock("../../../src/features/savings/savingsTasks", () => ({
  useSavingsMovesReplayed: () => true,
}))

const { chainFacts, savingsMoving, withdrawalInFlight } = await import(
  "../../../src/features/backupPasskey/backupPasskeyFacts"
)

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
  const move = (over: Partial<SavingsMoveRecord> = {}) =>
    ({
      direction: "in",
      withdrawalLocalId: "w1",
      escrow: "0x01",
      nonce: "0x02",
      recipientCommitment: "0x03",
      amount: "1",
      startTime: 0,
      ...over,
    } as SavingsMoveRecord)

  it("counts a move until its deposit is claimed or its escrow recovered", () => {
    expect(savingsMoving([move()], [])).toBe(true)
    const claimed = { inboxIndex: "1", amount: "1", claimed: true }
    expect(savingsMoving([move({ deposit: claimed })], [])).toBe(false)
    expect(savingsMoving([move({ recovered: { to: "0x04", txHashes: [] } })], [])).toBe(false)
  })

  const burn = (phase: WithdrawalRecord["phase"]) => ({ localId: "w1", phase } as WithdrawalRecord)

  it("leaves out a move whose burn failed, and a retired one", () => {
    expect(savingsMoving([move()], [burn("failed")])).toBe(false)
    expect(savingsMoving([move()], [burn("done")])).toBe(true)
    expect(savingsMoving([move({ retired: true })], [])).toBe(false)
  })

  it("counts a move out like a move in", () => {
    expect(savingsMoving([move({ direction: "out" })], [burn("done")])).toBe(true)
  })

  it("counts a Sky burn a rescan rebuilt until the settle pass adopts it", () => {
    const rebuilt = { ...burn("done"), skyMove: { direction: "in" } } as WithdrawalRecord
    expect(savingsMoving([], [rebuilt])).toBe(true)
    expect(savingsMoving([], [{ ...rebuilt, phase: "failed" }])).toBe(false)
    const claimed = { inboxIndex: "1", amount: "1", claimed: true }
    expect(savingsMoving([move({ deposit: claimed })], [rebuilt])).toBe(false)
    // A plain withdrawal is no Savings move.
    expect(savingsMoving([], [burn("done")])).toBe(false)
  })
})
