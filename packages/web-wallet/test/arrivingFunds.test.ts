/**
 * Funds on their way count in the balance they land in, at what will land, so a balance only drops
 * for a send or a withdrawal: a deposit from its sweep, a migration or a Savings move from its burn.
 */
import { describe, expect, it } from "vitest"
import { PaylinkActionEnum } from "@obsidion/core/constants"
import type {
  SIPADepositRecord,
  SavingsMoveRecord,
  Transaction,
  WithdrawalPhase,
  WithdrawalRecord,
} from "@obsidion/front-core"
import { arrivingFunds } from "../src/ui/screens/arrivingFunds"

const E18 = 10n ** 18n
const SIPA = `0x${"5a".repeat(20)}` as const
const none = { deposits: [], burns: [], moves: [], transactions: [] }

const deposit = (patch: Partial<SIPADepositRecord>): SIPADepositRecord =>
  ({ sipaAddress: SIPA, phase: "broadcast", amount: "800", ...patch } as SIPADepositRecord)

/** 85 gross, 0.1 tip, 0.05 old-portal cut, 0.3 arrival fee: 84.55 reaches the new balance. */
const migration = (phase: WithdrawalPhase): WithdrawalRecord =>
  ({
    localId: "m1",
    intent: "migration",
    recipient: SIPA,
    amount: "85",
    rawAmount: (85n * E18).toString(),
    relayerTip: (E18 / 10n).toString(),
    fpcFundingCut: ((5n * E18) / 100n).toString(),
    arrivalFee: ((3n * E18) / 10n).toString(),
    tokenSymbol: "DAI",
    phase,
    startTime: 1_000,
  } as WithdrawalRecord)

const move = (patch: Partial<SavingsMoveRecord>): SavingsMoveRecord =>
  ({
    direction: "in",
    withdrawalLocalId: "w1",
    amount: (800n * E18).toString(),
    net: ((79_937n * E18) / 100n).toString(),
    startTime: 1_000,
    ...patch,
  } as SavingsMoveRecord)

/** A move's burn: 800 DAI, its source cut and release tip, and the escrow's tip. */
const moveBurn = (phase: WithdrawalPhase = "l2_mined"): WithdrawalRecord =>
  ({
    localId: "w1",
    amount: "800",
    rawAmount: (800n * E18).toString(),
    fpcFundingCut: ((5n * E18) / 100n).toString(),
    relayerTip: (E18 / 10n).toString(),
    skyMove: { direction: "in", relayerTip: (E18 / 2n).toString() },
    tokenSymbol: "DAI",
    phase,
    startTime: 1_000,
  } as WithdrawalRecord)
const mined = [moveBurn()]

const claim = (status: Transaction["status"], action: string = PaylinkActionEnum.CLAIM) =>
  ({ action, status, token: { amount: 25, decimals: 18 } } as unknown as Transaction)

describe("arrivingFunds", () => {
  it("counts a deposit from its sweep, at its net, until it is claimed", () => {
    const net = (7995n * E18) / 10n
    const at = (patch: Partial<SIPADepositRecord>) =>
      arrivingFunds({ ...none, deposits: [deposit(patch)] }).main
    expect(at({ phase: "broadcast" })).toBe(0n)
    expect(at({ phase: "sweeping" })).toBe(0n)
    expect(at({ phase: "pendingClaim", netAmount: net.toString() })).toBe(net)
    expect(at({ phase: "claimed", netAmount: net.toString() })).toBe(0n)
    expect(at({ phase: "recoverable" })).toBe(0n)
  })

  it("counts a migration from its burn, then from its deposit's own net, never both", () => {
    const net = (8455n * E18) / 100n
    const at = (burn: WithdrawalRecord, arrival?: Partial<SIPADepositRecord>) =>
      arrivingFunds({ ...none, burns: [burn], deposits: arrival ? [deposit(arrival)] : [] }).main
    expect(at(migration("l2_mined"))).toBe(net)
    expect(at(migration("l2_mined"), { phase: "broadcast", amount: "0" })).toBe(net)
    expect(at(migration("done"), { phase: "pendingClaim", netAmount: net.toString() })).toBe(net)
    expect(at(migration("done"), { phase: "claimed", netAmount: net.toString() })).toBe(0n)
    expect(at(migration("failed"))).toBe(0n)
  })

  it("counts a move into Savings at its quote, then at the shares it landed, priced", () => {
    const quoted = (79_937n * E18) / 100n
    expect(arrivingFunds({ ...none, burns: mined, moves: [move({})] })).toEqual({
      main: 0n,
      savings: quoted,
    })
    const landed = move({
      deposit: { inboxIndex: "1", amount: (760n * E18).toString(), claimed: false },
    })
    const price = (105n * E18) / 100n
    expect(
      arrivingFunds({ ...none, burns: mined, moves: [landed], sharePrice: price }).savings,
    ).toBe(798n * E18)
    expect(arrivingFunds({ ...none, burns: mined, moves: [landed] }).savings).toBe(quoted)
  })

  it("counts a move back to Main at its quote, then at what it deposited", () => {
    const out = move({ direction: "out", net: (500n * E18).toString() })
    expect(arrivingFunds({ ...none, burns: mined, moves: [out] })).toEqual({
      main: 500n * E18,
      savings: 0n,
    })
    const landed = {
      ...out,
      deposit: { inboxIndex: "2", amount: (499n * E18).toString(), claimed: false },
    }
    expect(arrivingFunds({ ...none, burns: mined, moves: [landed] }).main).toBe(499n * E18)
  })

  it("counts nothing while a burn is still proving, as its source still holds the funds", () => {
    const proving = [moveBurn("submitting")]
    expect(arrivingFunds({ ...none, burns: proving, moves: [move({})] }).savings).toBe(0n)
    expect(arrivingFunds({ ...none, moves: [move({})] }).savings).toBe(0n)
    expect(arrivingFunds({ ...none, burns: [migration("submitting")] }).main).toBe(0n)
  })

  it("counts a move rebuilt without a quote at what its burn should land, never its gross", () => {
    const out = move({ direction: "out", amount: (100n * E18).toString(), net: undefined })
    // Unpriced yet: nothing, rather than the burned shares' full value.
    expect(arrivingFunds({ ...none, burns: mined, moves: [out] }).main).toBe(0n)
    const priced = { ...out, expectedNet: ((1034n * E18) / 10n).toString() }
    expect(arrivingFunds({ ...none, burns: mined, moves: [priced] }).main).toBe((1034n * E18) / 10n)
  })

  it("stops counting a move once it is claimed, recovered, or its burn failed", () => {
    const claimed = move({ deposit: { inboxIndex: "1", amount: "1", claimed: true } })
    const recovered = move({ recovered: { to: `0x${"ab".repeat(20)}`, txHashes: [] } })
    expect(arrivingFunds({ ...none, burns: mined, moves: [claimed] }).savings).toBe(0n)
    expect(arrivingFunds({ ...none, burns: mined, moves: [recovered] }).savings).toBe(0n)
    expect(arrivingFunds({ ...none, burns: [moveBurn("failed")], moves: [move({})] }).savings).toBe(
      0n,
    )
  })

  it("counts a link claim while its transaction is pending, and no send", () => {
    expect(arrivingFunds({ ...none, transactions: [claim("pending")] }).main).toBe(25n * E18)
    expect(arrivingFunds({ ...none, transactions: [claim("success")] }).main).toBe(0n)
    expect(arrivingFunds({ ...none, transactions: [claim("pending", "send")] }).main).toBe(0n)
  })
})
