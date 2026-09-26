/**
 * The deposit sheet's own view of a transfer it just broadcast: the figures the wallet charged,
 * kept until the store has something better, and the sheet that renders them.
 */
import React, { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import type { Address, Hash, Hex } from "viem"
import type { SIPADepositRecord } from "@obsidion/front-core"

vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: () => ({ l1ChainId: 11155111, network: "testnet", nodeUrl: "http://node.invalid" }),
}))
vi.mock("../src/lib/explorer", () => ({
  l1TxUrl: (_chainId: number, hash: string) => `https://etherscan.invalid/tx/${hash}`,
  l1AddressUrl: (_chainId: number, address: string) =>
    `https://etherscan.invalid/address/${address}`,
  l2TxUrl: () => undefined,
}))
vi.mock("@obsidion/web-ds", () => ({
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  PrimaryGradientButton: () => null,
  Spinner: () => null,
  TopNavIconButton: () => null,
}))

const { sentDepositRecord } = await import("../src/features/deposit/sentDepositRecord")
const { DepositDetailModal } = await import("../src/ui/screens/DepositDetailModal")
const { usdFigure } = await import("../src/ui/format")

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const L1_CHAIN_ID = 11155111
const SIPA = `0x${"11".repeat(20)}` as Address
const FUNDING_TX = `0x${"e6".repeat(32)}` as Hash
const SWEEP_TX = `0x${"5e".repeat(32)}` as Hash
const WALLET = `0x${"a1".repeat(20)}` as Hex

/** 0.25 relayer sweep fee + 0.10 portal funding cut, base units. */
const FACTS = {
  fee: "0.35",
  token: `0x${"bb".repeat(20)}` as Address,
  sweepFeeAtomic: 250_000_000_000_000_000n,
  fpcFundingCutAtomic: 100_000_000_000_000_000n,
}

const SENT = {
  address: SIPA,
  txHash: FUNDING_TX,
  amount: "100.35",
  tokenSymbol: "DAI",
  walletName: "Rainbow",
  walletAddress: WALLET,
}

/** What discovery writes for a pooled address before anything is sent to it. */
const placeholder = (patch: Partial<SIPADepositRecord> = {}): SIPADepositRecord =>
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
  } as SIPADepositRecord)

describe("sentDepositRecord", () => {
  it("keeps the charged figures over a placeholder record", () => {
    const merged = sentDepositRecord(SENT, placeholder(), L1_CHAIN_ID, FACTS)!

    expect(merged.amount).toBe(SENT.amount)
    expect(merged.fee).toBe("350000000000000000")
    expect(merged.fpcFundingCut).toBe(FACTS.fpcFundingCutAtomic.toString())
    expect(merged.fundingTxHash).toBe(FUNDING_TX)
    expect(merged.walletName).toBe(SENT.walletName)
  })

  it("keeps the charged figures over a freshly resolved address", () => {
    // Resolution seeds the record the moment it derives the address, before any transfer exists:
    // a zero amount there is "nothing sent yet", never "this deposit was for nothing".
    const merged = sentDepositRecord(SENT, placeholder({ phase: "resolved" }), L1_CHAIN_ID, FACTS)!

    expect(merged.amount).toBe(SENT.amount)
    expect(merged.phase).toBe("funding")
    expect(merged.fundingTxHash).toBe(FUNDING_TX)
  })

  it("takes the derived note fields, and keeps its own phase over a placeholder's", () => {
    const merged = sentDepositRecord(SENT, placeholder(), L1_CHAIN_ID, FACTS)!

    // The placeholder's `broadcast` says the address was published, not that this transfer was seen.
    expect(merged.phase).toBe("funding")
    expect(merged.recipientHash).toBe("0x02")
    expect(merged.messageSecret).toBe("0x01")
  })

  it("keeps the sent token over a pooled placeholder's manifest token", () => {
    const pooled = placeholder({
      tokenSymbol: "DAI",
      tokenDecimals: 18,
      tokenAddress: `0x${"da".repeat(20)}` as Address,
    })

    const merged = sentDepositRecord({ ...SENT, tokenSymbol: "USDC" }, pooled, L1_CHAIN_ID, FACTS)!

    expect(merged.tokenSymbol).toBe("USDC")
    expect(merged.tokenDecimals).toBeUndefined()
    expect(merged.tokenAddress).toBeUndefined()
    expect(merged.phase).toBe("funding")
  })

  it("takes the store's token once the record is funded", () => {
    const funded = placeholder({
      phase: "sweeping",
      amount: "100",
      tokenSymbol: "USDT",
      tokenDecimals: 6,
    })

    const merged = sentDepositRecord(SENT, funded, L1_CHAIN_ID, FACTS)!

    expect(merged).toMatchObject({ phase: "sweeping", tokenSymbol: "USDT", tokenDecimals: 6 })
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

  it("stands alone when the store has no record at all", () => {
    expect(sentDepositRecord(SENT, undefined, L1_CHAIN_ID, FACTS)).toMatchObject({
      phase: "funding",
      amount: SENT.amount,
      fundingTxHash: FUNDING_TX,
    })
  })

  it("keeps a recovered record's own phase and token, zero amount and all", () => {
    // A recovery empties the address, so the record reads zero — a settled fact, not a placeholder.
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

  it("falls back to the store while the quote is unknown", () => {
    const stored = placeholder()
    expect(sentDepositRecord(SENT, stored, L1_CHAIN_ID, undefined)).toBe(stored)
  })
})

describe("DepositDetailModal on a just-sent deposit", () => {
  let container: HTMLDivElement
  let root: Root

  const valueOf = (label: string) =>
    Array.from(container.querySelectorAll(".ww-sheet__fact"))
      .find((row) => row.querySelector("span")?.textContent === label)
      ?.querySelector("b, a")
      ?.textContent?.replace(/\s+/g, " ")
      .trim()

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("shows the gross, the fee, the net and the funding tx straight away", async () => {
    const merged = sentDepositRecord(SENT, placeholder(), L1_CHAIN_ID, FACTS)!
    await act(async () => {
      root.render(<DepositDetailModal record={merged} onClose={vi.fn()} />)
    })

    expect(valueOf("Sent")).toBe(usdFigure("100.35"))
    expect(valueOf("Fee")).toBe(usdFigure("0.35"))
    expect(valueOf("Received")).toBe(usdFigure("100"))
    expect(valueOf("Tx hash")).not.toBe("--")
  })
})
