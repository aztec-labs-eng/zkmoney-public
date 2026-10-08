/**
 * Deposit detail sheet — source wallet, dollar facts, and the Figma status words
 * (Receiving / Completed / Canceled). Funding hash holds its row from the moment the sheet opens.
 */
import React, { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import type { Address, Hash } from "viem"
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

const { DepositDetailModal } = await import("../src/ui/screens/DepositDetailModal")
const { whenLabel } = await import("../src/ui/detailRows")

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const FUNDER = `0x${"f0".repeat(20)}` as Address
const WALLET = `0x${"a1".repeat(20)}`
const FUNDING_TX = `0x${"e6".repeat(32)}` as Hash
// Everything the deposit does not credit, and the portal's share of it.
const FEE = "750000000000000000"
const CUT = "250000000000000000"

const record = (patch: Partial<SIPADepositRecord> = {}): SIPADepositRecord =>
  ({
    sipaAddress: `0x${"11".repeat(20)}`,
    recipientL2Address: `0x${"0a".repeat(32)}`,
    messageSecret: "0x01",
    recipientHash: "0x02",
    recoveryAddress: `0x${"bb".repeat(20)}`,
    l1ChainId: 11155111,
    amount: "115",
    tokenSymbol: "DAI",
    fee: FEE,
    fpcFundingCut: CUT,
    netAmount: "114250000000000000000",
    phase: "claimed",
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_000_000,
    walletName: "Rainbow",
    ...patch,
  } as SIPADepositRecord)

describe("DepositDetailModal", () => {
  let container: HTMLDivElement
  let root: Root

  const valueOf = (label: string) =>
    Array.from(container.querySelectorAll(".ww-sheet__fact"))
      .find((row) => row.querySelector("span")?.textContent === label)
      ?.querySelector("b, a")
      ?.textContent?.replace(/\s+/g, " ")
      .trim()

  /** The figure the sheet leads with, above the facts card. */
  const headline = () => container.querySelector(".ww-sheet__title span")?.textContent?.trim()

  /** The date under that figure. */
  const subtitle = () => container.querySelector(".ww-sheet__title small")?.textContent?.trim()

  const show = (r: SIPADepositRecord) =>
    act(async () => {
      root.render(<DepositDetailModal record={r} onClose={vi.fn()} />)
    })

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

  it("names the source wallet over the funder address", async () => {
    await show(record({ fundingFromAddress: FUNDER, fundingTxHash: FUNDING_TX }))

    expect(container.textContent).toContain("Rainbow")
    expect(container.textContent).toContain(FUNDER.slice(0, 6))
  })

  it("falls back to the account this wallet funded from", async () => {
    await show(record({ walletName: undefined, walletAddress: WALLET }))

    expect(container.textContent).toContain("Wallet")
    expect(container.textContent).toContain(WALLET.slice(0, 6))
  })

  it("holds the tx-hash row while the funding transfer is still unread", async () => {
    await show(record({ phase: "broadcast", endTime: undefined, fundingTxHash: undefined }))

    expect(valueOf("Tx hash")).toBe("--")
    expect(container.textContent).toContain("--")
    expect(valueOf("Status")).toContain("Receiving")
  })

  it("dates a pending deposit by when it started, having no end to date it by", async () => {
    await show(record({ phase: "funding", endTime: undefined }))

    expect(subtitle()).toBe(whenLabel(1_700_000_000_000))
    expect(subtitle()).not.toBe("--")
  })

  it("names the token the funder sent over the one the sweep credited", async () => {
    await show(
      record({ fundingTokenSymbol: "USDC", fundingFromAddress: FUNDER, fundingTxHash: FUNDING_TX }),
    )

    expect(valueOf("Token")).toBe("USDC")
    expect(container.textContent).not.toContain("DAI")
  })

  it("shows dollar amounts and Completed once the deposit has credited", async () => {
    await show(record({ fundingFromAddress: FUNDER, fundingTxHash: FUNDING_TX }))

    expect(valueOf("Sent")).toBe("$115")
    // The whole deduction, the portal's cut included; gross and net are its two sides.
    expect(valueOf("Fee")).toBe("$0.75")
    expect(valueOf("Received")).toBe("$114.25")
    expect(valueOf("Status")).toContain("Completed")
    expect(container.querySelector<HTMLAnchorElement>("a[href*='tx']")?.href).toContain(FUNDING_TX)
  })

  it("keeps the deposit address and every on-chain leg as explorer rows", async () => {
    const sweep = `0x${"5e".repeat(32)}` as Hash
    const recovery = `0x${"4e".repeat(32)}` as Hash
    const claim = `0x${"c1".repeat(64)}`
    await show(
      record({
        fundingFromAddress: FUNDER,
        fundingTxHash: FUNDING_TX,
        sweepTxHash: sweep,
        recoveryTxHash: recovery,
        claimTxHash: claim,
      }),
    )

    expect(valueOf("Deposit address")).toContain(record().sipaAddress.slice(0, 6))
    expect(
      Array.from(container.querySelectorAll("a")).some((a) =>
        a.href.includes(record().sipaAddress),
      ),
    ).toBe(true)
    expect(valueOf("Sweep tx")).toContain(sweep.slice(0, 6))
    expect(valueOf("Recovery tx")).toContain(recovery.slice(0, 6))
    expect(valueOf("Claim tx")).toContain(claim.slice(0, 6))
  })

  it("leads with what lands on L2, not what the wallet was charged", async () => {
    await show(record({ fundingFromAddress: FUNDER, fundingTxHash: FUNDING_TX }))

    expect(headline()).toBe("$114.25")
    expect(valueOf("Sent")).toBe("$115")
  })

  it("shows a pending wallet deposit's amount rather than a dash", async () => {
    // The transfer is broadcast and nothing has been discovered yet — the figure is still known.
    await show(
      record({
        phase: "funding",
        amount: "10.5",
        fee: "500000000000000000",
        netAmount: undefined,
        endTime: undefined,
        fundingTxHash: FUNDING_TX,
      }),
    )

    expect(headline()).toBe("$10")
    expect(valueOf("Sent")).toBe("$10.50")
    expect(valueOf("Fee")).toBe("$0.50")
    expect(valueOf("Received")).toBe("$10")
  })

  it("leads with the gross for a deposit that will never credit L2", async () => {
    await show(record({ phase: "recoverable", endTime: undefined }))

    expect(headline()).toBe("$115")
  })

  it("calls an unexpected error Deposit failed", async () => {
    await show(record({ phase: "failed", endTime: 1_700_000_000_000 }))

    expect(valueOf("Status")).toContain("Deposit failed")
  })
})
