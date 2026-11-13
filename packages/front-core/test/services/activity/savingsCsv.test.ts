import { describe, expect, it } from "vitest"
import { parseUnits } from "viem"
import type { WithdrawalRecord } from "../../../src/core/services/bridge/types"
import type { MoveRecord } from "../../../src/engine/moveTransition"
import {
  activityCsvFileName,
  buildSavingsCsvRows,
  savingsCsv,
} from "../../../src/core/services/activity/activityCsv"
import { DAI, T0 } from "./csvFixtures"

describe("savings", () => {
  const BURN = "burn-1"
  const burn = {
    localId: BURN,
    recipient: "0x00000000000000000000000000000000000000ee",
    recipientProvenance: "saved-recipient",
    amount: "10",
    tokenSymbol: "DAI",
    tokenDecimals: 18,
    phase: "done",
    startTime: T0,
    l2TxHash: "0xburn",
    minedAt: T0 + 500,
  } as WithdrawalRecord
  const burns = new Map([[BURN, burn]])

  /** A move in of 10 DAI whose vault took 9.9 for 9.5 shares, claimed on the Savings side. */
  function move(extra: Partial<MoveRecord> = {}): MoveRecord {
    return {
      id: BURN,
      holdingId: "fea-sky",
      rail: "executor",
      direction: "in",
      withdrawalLocalId: BURN,
      nonce: "0x01",
      recipientCommitment: "0x02",
      scanFrom: 0n,
      amount: parseUnits("10", 18),
      phase: "claimed",
      startTime: T0,
      deposit: { inboxIndex: 3n, amount: parseUnits("9.5", 18), at: T0 + 1000 },
      l1: { releaseTx: "0xrun" },
      assets: parseUnits("9.9", 18),
      ...extra,
    } as MoveRecord
  }

  it("a move in receives what the vault took, dated when its deposit landed", () => {
    expect(buildSavingsCsvRows({ walletToken: DAI, moves: [move()], burns })).toEqual([
      {
        timestampMs: T0 + 1000,
        type: "Savings deposit",
        received: { amount: "9.9", currency: "DAI" },
        aztecTxHash: "0xburn",
        ethereumTxHash: "0xrun",
      },
    ])
  })

  it("a move in with no vault figure receives its quote's conversion, else what it burned", () => {
    const out = parseUnits("9.8", 18)
    const quote = {
      routed: out,
      relayerTip: 0n,
      conversionOut: out,
      conversionMinOut: out,
      expectedOut: out,
      minOut: out,
      withdrawalFee: 0n,
    }
    const quoted = move({ assets: undefined, quote })
    expect(
      buildSavingsCsvRows({ walletToken: DAI, moves: [quoted], burns })[0]?.received?.amount,
    ).toBe("9.8")
    const unread = move({ assets: undefined })
    expect(
      buildSavingsCsvRows({ walletToken: DAI, moves: [unread], burns })[0]?.received?.amount,
    ).toBe("10")
  })

  it("a move out sends what landed on Main, with the rest of what the vault paid as the fee, dated at its burn", () => {
    const out = move({ direction: "out", amount: parseUnits("9.5", 18) })
    expect(buildSavingsCsvRows({ walletToken: DAI, moves: [out], burns })).toEqual([
      {
        timestampMs: T0 + 500,
        type: "Savings withdrawal",
        sent: { amount: "9.5", currency: "DAI" },
        fee: { amount: "0.4", currency: "DAI" },
        aztecTxHash: "0xburn",
        ethereumTxHash: "0xrun",
      },
    ])
    const unread = move({ direction: "out", assets: undefined })
    const row = buildSavingsCsvRows({ walletToken: DAI, moves: [unread], burns })[0]
    expect(row?.sent).toEqual({ amount: "9.5", currency: "DAI" })
    expect(row?.fee).toBeUndefined()
  })

  it("names the Ethereum transaction that ran the move's escrow, not its burn's release", () => {
    const l1 = { releaseTx: "0xrelease", depositTx: "0xrun" } as MoveRecord["l1"]
    const ran = move({ rail: "skyEscrow", l1 })
    expect(buildSavingsCsvRows({ walletToken: DAI, moves: [ran], burns })[0]?.ethereumTxHash).toBe(
      "0xrun",
    )
  })

  it("a move whose deposit is not yet claimed has no row", () => {
    const pending = move({ phase: "depositSeen" })
    expect(
      buildSavingsCsvRows({
        walletToken: DAI,
        moves: [pending, move({ deposit: undefined })],
        burns,
      }),
    ).toEqual([])
  })

  it("has its own file", () => {
    const lines = savingsCsv({ walletToken: DAI, moves: [move()], burns })
      .trimEnd()
      .split("\r\n")
    expect(lines[1]).toBe("2026-01-02 03:04:06 UTC,,,9.9,DAI,,,,,,Savings deposit,0xrun") // debt-check-ignore: moved unchanged from activityCsv.test.ts; pins the exported file's row
    expect(activityCsvFileName(new Date(T0), "savings")).toBe(
      "zkmoney-savings-activity-2026-01-02.csv",
    )
  })
})
