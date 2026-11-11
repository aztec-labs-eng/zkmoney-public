/** Fixtures shared by the accounting CSV tests. */
import { expect } from "vitest"
import { parseUnits } from "viem"
import type { WithdrawalRecord } from "../../../src/core/services/bridge/types"
import type { SipaDeposit, SIPASweep } from "../../../src/engine/sipaDeposits"
import type { ActivityItem } from "../../../src/engine/feedRules"
import type { Transaction } from "../../../src/types/transactions"
import {
  buildActivityCsvRows,
  type ActivityCsvRow,
  type ActivityCsvSources,
} from "../../../src/core/services/activity/activityCsv"

export const T0 = Date.UTC(2026, 0, 2, 3, 4, 5)
export const TOKEN = {
  address: "0x1",
  name: "Dai",
  symbol: "DAI",
  decimals: 18,
  logo: "",
  amount: 12.5,
  price: 1,
}
export const DAI = { symbol: "DAI", decimals: 18 }
export const EMPTY: ActivityCsvSources = {
  walletToken: DAI,
  transactions: [],
  items: [],
  requests: [],
}

export function tx(action: string, extra: Record<string, unknown> = {}): Transaction {
  return {
    action,
    emailPaymentAction: action,
    status: "success",
    timestamp: T0,
    txHash: `0x${action.length}`,
    token: TOKEN,
    ...extra,
  } as unknown as Transaction
}

export function withdrawal(extra: Partial<WithdrawalRecord> = {}): ActivityItem {
  return {
    kind: "bridge.withdrawal",
    record: {
      localId: "wdraw_1",
      recipient: "0x00000000000000000000000000000000000000aa",
      recipientProvenance: "saved-recipient",
      amount: "10",
      rawAmount: parseUnits("10", 18).toString(),
      relayerTip: parseUnits("0.5", 18).toString(),
      tokenSymbol: "DAI",
      tokenDecimals: 18,
      phase: "done",
      startTime: T0,
      endTime: T0 + 1000,
      l2TxHash: "0xl2",
      l1TxHash: "0xl1",
      receivedAmount: parseUnits("9.5", 18).toString(),
      ...extra,
    } as WithdrawalRecord,
  }
}

/** A claimed sweep that took `gross` DAI off the address and credited `net`; no gross when never read. */
export function sweep(
  inboxIndex: string,
  gross: string | undefined,
  net: string,
  extra: Partial<SIPASweep> = {},
): SIPASweep {
  return {
    inboxIndex,
    sweepTxHash: `0xsweep${inboxIndex}` as SIPASweep["sweepTxHash"],
    netAmount: parseUnits(net, 18).toString(),
    ...(gross === undefined
      ? {}
      : {
          grossAmount: parseUnits(gross, 18).toString(),
          fundingTokenSymbol: "DAI",
          fundingTokenDecimals: 18,
        }),
    ...extra,
  }
}

export function deposit(extra: Partial<SipaDeposit> = {}): ActivityItem {
  return {
    kind: "bridge.sipaDeposit",
    record: {
      sipaAddress: "0x00000000000000000000000000000000000000Bb",
      amount: "20",
      netAmount: parseUnits("19", 18).toString(),
      fee: parseUnits("1", 18).toString(),
      tokenSymbol: "DAI",
      phase: "claimed",
      startTime: T0,
      inboxIndex: "7",
      claimedInboxIndexes: ["7"],
      sweeps: [sweep("7", "20", "19")],
      fundingFromAddress: "0x00000000000000000000000000000000000000cc",
      fundingTokenSymbol: "DAI",
      fundingTxHash: "0xfund",
      ...extra,
    } as SipaDeposit,
  }
}

export function only(sources: Partial<ActivityCsvSources>): ActivityCsvRow | undefined {
  const rows = buildActivityCsvRows({ ...EMPTY, ...sources })
  expect(rows.length).toBeLessThanOrEqual(1)
  return rows[0]
}
