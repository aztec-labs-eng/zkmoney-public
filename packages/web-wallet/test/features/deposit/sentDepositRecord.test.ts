// @vitest-environment node
/**
 * The deposit sheet's own view of a transfer it just broadcast: the figures the wallet charged, kept
 * until the store has something better.
 */
import { describe, expect, it } from "vitest"
import type { Address, Hash, Hex } from "viem"
import type { SipaDeposit } from "@obsidion/front-core"
import {
  pendingDepositRecord,
  sentDepositRecord,
} from "../../../src/features/deposit/sentDepositRecord"
import { ROW_DAI, ROW_USDC } from "../../support/depositTokens"

const L1_CHAIN_ID = 11155111
const SIPA = `0x${"11".repeat(20)}` as Address
const FUNDING_TX = `0x${"e6".repeat(32)}` as Hash
const SWEEP_TX = `0x${"5e".repeat(32)}` as Hash
const WALLET = `0x${"a1".repeat(20)}` as Hex

/** The 0.25 relayer sweep fee. */
const FACTS = {
  fee: "0.25",
  token: `0x${"bb".repeat(20)}` as Address,
  sweepFeeAtomic: 250_000_000_000_000_000n,
  txAmountCap: 5166n * 10n ** 18n,
}

const SENT = {
  address: SIPA,
  txHash: FUNDING_TX,
  amount: "100.25",
  tokenSymbol: "DAI",
  tokenAddress: ROW_DAI,
  tokenDecimals: 18,
  walletName: "Rainbow",
  walletAddress: WALLET,
}

/** What discovery writes for a pooled address before anything is sent to it. */
const placeholder = (patch: Partial<SipaDeposit> = {}): SipaDeposit =>
  ({
    sipaAddress: SIPA,
    phase: "broadcast",
    amount: "0",
    tokenSymbol: "DAI",
    l1ChainId: L1_CHAIN_ID,
    startTime: 1_700_000_000_000,
    recipientL2Address: `0x${"0a".repeat(32)}`,
    messageSecret: "0x01",
    recipientHash: "0x02",
    recoveryAddress: `0x${"bb".repeat(20)}`,
    ...patch,
  } as SipaDeposit)

describe("pendingDepositRecord", () => {
  it("stands in with the sent figures, the quoted fee in base units and blank note fields", () => {
    const before = Date.now()
    const pending = pendingDepositRecord(SENT, L1_CHAIN_ID, FACTS)

    expect(pending).toMatchObject({
      sipaAddress: SIPA,
      phase: "funding",
      amount: SENT.amount,
      fee: FACTS.sweepFeeAtomic.toString(),
      tokenSymbol: "DAI",
      tokenAddress: ROW_DAI,
      tokenDecimals: 18,
      l1ChainId: L1_CHAIN_ID,
      fundingTxHash: FUNDING_TX,
      walletName: "Rainbow",
      walletAddress: WALLET,
      recipientL2Address: "",
      messageSecret: "",
      recipientHash: "",
      recoveryAddress: "",
    })
    expect(pending.startTime).toBeGreaterThanOrEqual(before)
  })
})

describe("sentDepositRecord", () => {
  it("keeps the charged figures over a freshly resolved address", () => {
    // Resolution seeds the record before any transfer exists: a zero amount there is "nothing sent
    // yet", never "this deposit was for nothing".
    const merged = sentDepositRecord(SENT, placeholder({ phase: "resolved" }), L1_CHAIN_ID, FACTS)!

    expect(merged.amount).toBe(SENT.amount)
    expect(merged.phase).toBe("funding")
    expect(merged.fundingTxHash).toBe(FUNDING_TX)
  })

  it("keeps the sent token over a pooled placeholder's manifest token", () => {
    const pooled = placeholder({
      tokenSymbol: "DAI",
      tokenDecimals: 18,
      tokenAddress: `0x${"da".repeat(20)}` as Address,
    })

    const usdc = { ...SENT, tokenSymbol: "USDC", tokenAddress: ROW_USDC, tokenDecimals: 6 }
    const merged = sentDepositRecord(usdc, pooled, L1_CHAIN_ID, FACTS)!

    expect(merged.tokenSymbol).toBe("USDC")
    expect(merged.tokenDecimals).toBe(6)
    expect(merged.tokenAddress).toBe(ROW_USDC)
    expect(merged.fee).toBe(FACTS.sweepFeeAtomic.toString())
    expect(merged.phase).toBe("funding")
    // The placeholder's note fields are known; the stand-in's blanks do not win over them.
    expect(merged.messageSecret).toBe("0x01")
  })

  it("upgrades to the store's own amount, fee and hashes once the sweep lands", () => {
    const swept = placeholder({
      phase: "sweeping",
      amount: "100",
      fee: "400000000000000000",
      netAmount: "100000000000000000000",
      sweepTxHash: SWEEP_TX,
    })

    const merged = sentDepositRecord(SENT, swept, L1_CHAIN_ID, FACTS)!

    expect(merged).toMatchObject({
      phase: "sweeping",
      amount: "100",
      fee: "400000000000000000",
      sweepTxHash: SWEEP_TX,
    })
    // The charged view still owns what only it knows.
    expect(merged.fundingTxHash).toBe(FUNDING_TX)
  })

  it("keeps a recovered record's own phase and token, zero amount and all", () => {
    // A recovery empties the address, so the record reads zero: a settled fact, not a placeholder.
    const recovered = placeholder({
      phase: "recovered",
      amount: "0",
      tokenSymbol: "USDT",
      tokenDecimals: 6,
      recoveryTxHash: SWEEP_TX,
    })

    const merged = sentDepositRecord(SENT, recovered, L1_CHAIN_ID, FACTS)!

    expect(merged).toMatchObject({ phase: "recovered", amount: "0", tokenSymbol: "USDT" })
    expect(merged.fundingTxHash).toBe(FUNDING_TX)
  })

  it("is the stand-in alone while the store holds nothing for the address", () => {
    expect(sentDepositRecord(SENT, undefined, L1_CHAIN_ID, FACTS)).toMatchObject({
      phase: "funding",
      amount: SENT.amount,
    })
  })

  it("falls back to the store while the quote is unknown", () => {
    const stored = placeholder()
    expect(sentDepositRecord(SENT, stored, L1_CHAIN_ID, undefined)).toBe(stored)
  })
})
