import { describe, expect, it } from "vitest"
import type { Hex } from "viem"
import type { WithdrawalPhase, WithdrawalRecord } from "../../../src/core/services/bridge/types"
import {
  isFundsLegUnsent,
  isWithdrawalGroupTerminal,
  withdrawalGroupAmount,
  withdrawalGroupTime,
  withdrawalGroupsOf,
  worstWithdrawalPhase,
} from "../../../src/core/services/bridge/withdrawalGroups"

const GROUP_A = `0x${"a1".repeat(16)}` as Hex
const GROUP_B = `0x${"b2".repeat(16)}` as Hex

let seq = 0

function record(overrides: Partial<WithdrawalRecord> = {}): WithdrawalRecord {
  seq += 1
  return {
    localId: `wdraw_${seq}`,
    recipient: "0x0000000000000000000000000000000000000003",
    recipientProvenance: "saved-recipient",
    amount: "1",
    tokenSymbol: "DAI",
    phase: "done",
    startTime: 1_000 + seq,
    ...overrides,
  } as WithdrawalRecord
}

const gas = (overrides: Partial<WithdrawalRecord> = {}) =>
  record({ groupId: GROUP_A, groupLeg: "gas", ...overrides })
const funds = (overrides: Partial<WithdrawalRecord> = {}) =>
  record({ groupId: GROUP_A, groupLeg: "funds", ...overrides })

const groupOf = (...records: WithdrawalRecord[]) => withdrawalGroupsOf(records)[0]

/** A gas leg in one phase and, when named, a funds leg in another. */
const pair = (gasPhase: WithdrawalPhase, fundsPhase?: WithdrawalPhase) =>
  groupOf(gas({ phase: gasPhase }), ...(fundsPhase ? [funds({ phase: fundsPhase })] : []))

describe("withdrawalGroupsOf", () => {
  it("groups by groupId, gas first, earliest group first, ungrouped records left out", () => {
    const f = funds({ startTime: 10 })
    const g = gas({ startTime: 20 })
    const groups = withdrawalGroupsOf([gas({ groupId: GROUP_B, startTime: 50 }), record(), f, g])
    expect(groups.map((group) => group.groupId)).toEqual([GROUP_A, GROUP_B])
    expect(groups[0].records).toEqual([g, f])
    expect(groups[0].legs).toEqual({ gas: g, funds: f })
  })

  it("keeps the latest record per leg when a leg was sent again", () => {
    const first = funds({ phase: "failed", startTime: 20, endTime: 21 })
    const again = funds({ phase: "submitting", startTime: 30 })
    const group = groupOf(gas({ startTime: 10 }), again, first)
    expect(group.legs.funds).toBe(again)
    expect(group.records).toEqual([group.legs.gas, first, again])
  })
})

describe("isWithdrawalGroupTerminal", () => {
  it.each<[WithdrawalPhase, WithdrawalPhase | undefined, boolean]>([
    ["done", "l2_mined", false],
    ["done", "failed", true],
    ["recoverable", undefined, false],
    ["done", undefined, false],
    ["recovered", undefined, true],
    ["failed", undefined, true],
  ])("gas %s with funds %s -> %s", (gasPhase, fundsPhase, terminal) => {
    expect(isWithdrawalGroupTerminal(pair(gasPhase, fundsPhase))).toBe(terminal)
  })
})

describe("isFundsLegUnsent", () => {
  it.each<[WithdrawalPhase, WithdrawalPhase | undefined, boolean]>([
    ["submitting", undefined, false],
    ["l2_mined", undefined, true],
    ["done", undefined, true],
    ["recoverable", undefined, false],
    ["recovered", undefined, false],
    ["failed", undefined, false],
    ["done", "failed", false],
    ["done", "done", false],
  ])("gas %s with funds %s -> %s", (gasPhase, fundsPhase, unsent) => {
    expect(isFundsLegUnsent(pair(gasPhase, fundsPhase))).toBe(unsent)
  })
})

describe("worstWithdrawalPhase", () => {
  it.each<[WithdrawalPhase, WithdrawalPhase | undefined, WithdrawalPhase]>([
    ["done", "failed", "failed"],
    ["failed", "l2_mined", "failed"],
    ["recoverable", "submitting", "recoverable"],
    ["done", "submitting", "submitting"],
    ["finalizing_l1", "l2_mined", "l2_mined"],
    ["swapping", "awaiting_proven", "awaiting_proven"],
    ["swapping", "done", "swapping"],
    ["recovered", "done", "recovered"],
    ["done", "done", "done"],
    ["failed", undefined, "failed"],
  ])("gas %s with funds %s -> %s", (gasPhase, fundsPhase, worst) => {
    expect(worstWithdrawalPhase(pair(gasPhase, fundsPhase))).toBe(worst)
  })
})

describe("withdrawalGroupTime", () => {
  it.each<[string, Partial<WithdrawalRecord>, number]>([
    ["latest endTime once every leg has settled", { endTime: 300 }, 500],
    ["latest startTime while a leg is still in flight", { phase: "l2_mined" }, 20],
  ])("is the %s", (_rule, fundsLeg, time) => {
    const legs = [gas({ startTime: 10, endTime: 500 }), funds({ startTime: 20, ...fundsLeg })]
    expect(withdrawalGroupTime(groupOf(...legs))).toBe(time)
  })
})

describe("withdrawalGroupAmount", () => {
  it.each<[string[], string]>([
    [["0.1", "0.2"], "0.3"],
    [["1.25", "0.5"], "1.75"],
    [["2", "0.005"], "2.005"],
    [["1.5", "0.5"], "2"],
    [["12.5"], "12.5"],
    // A funds leg sent again counts once, as its latest try.
    [["1", "5", "5"], "6"],
  ])("adds gas and funds of %j exactly as %s", ([gasAmount, ...fundsTries], sum) => {
    const legs = [gas({ amount: gasAmount }), ...fundsTries.map((amount) => funds({ amount }))]
    expect(withdrawalGroupAmount(groupOf(...legs))).toBe(sum)
  })
})
