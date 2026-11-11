/**
 * The status a bridge record shows on its feed row and in its detail modal. A deposit's row and
 * sheet read one word per phase, and every word the row names draws a badge; the withdrawal legs
 * that wait on the same thing read one state.
 */
import { describe, expect, it } from "vitest"
import type { Hex } from "viem"
import {
  WITHDRAWAL_PHASE_COPY,
  upgradeRunsOf,
  type ActivityItem,
  type SIPADepositPhase,
  type SipaDeposit,
} from "@obsidion/front-core"
import {
  depositAttribution,
  depositGrossFigure,
  depositHeadline,
  depositRowAmount,
  depositRowStatusLabel,
  upgradeRowStatusLabel,
} from "../../../src/ui/screens/activityView"
import { tokenAmount, usdFigure } from "../../../src/ui/format"
import { depositStatus } from "../../../src/ui/screens/DepositDetailModal/DepositDetailModal"
import { statusBadgeStyle } from "@obsidion/web-ds"

const WITHDRAWAL_PHASE_LABEL = Object.fromEntries(
  Object.entries(WITHDRAWAL_PHASE_COPY).map(([phase, copy]) => [phase, copy.pill]),
) as Record<keyof typeof WITHDRAWAL_PHASE_COPY, string | undefined>

const SWEEP_TX = `0x${"5e".repeat(32)}` as Hex

const deposit = (phase: SIPADepositPhase, sweepTxHash?: Hex): SipaDeposit =>
  ({
    sipaAddress: `0x${"11".repeat(20)}`,
    recipientL2Address: `0x${"0a".repeat(32)}`,
    messageSecret: "0x01",
    recipientHash: "0x02",
    recoveryAddress: `0x${"bb".repeat(20)}`,
    l1ChainId: 11155111,
    amount: "18",
    tokenSymbol: "DAI",
    phase,
    startTime: 1,
    sweepTxHash,
  } as SipaDeposit)

const DEPOSIT_PHASES: SIPADepositPhase[] = [
  "resolved",
  "funding",
  "funded",
  "broadcast",
  "sweeping",
  "pendingClaim",
  "claimed",
  "recovered",
  "recoverable",
  "failed",
]

describe("depositStatus", () => {
  it("keeps every in-flight phase on the pending badge", () => {
    for (const phase of [
      "resolved",
      "funding",
      "funded",
      "broadcast",
      "sweeping",
      "pendingClaim",
    ] as const) {
      expect(depositStatus(deposit(phase)).badge, phase).toBe("pending")
    }
    expect(depositStatus(deposit("sweeping", SWEEP_TX)).badge).toBe("pending")
  })

  it("reads Awaiting funds, Receiving, Crediting, then Completed", () => {
    expect(depositStatus(deposit("resolved")).label).toBe("Awaiting funds")
    expect(depositStatus({ ...deposit("broadcast"), amount: "0" }).label).toBe("Awaiting funds")
    for (const phase of ["funding", "funded", "broadcast", "sweeping"] as const) {
      expect(depositStatus(deposit(phase)).label, phase).toBe("Receiving")
    }
    expect(depositStatus(deposit("sweeping", SWEEP_TX)).label).toBe("Receiving")
    expect(depositStatus(deposit("pendingClaim")).label).toBe("Crediting")
    expect(depositStatus(deposit("claimed")).label).toBe("Completed")
  })
})

describe("depositRowAmount", () => {
  it("adds back the price a tag purchase row lists, so the two rows net what landed", () => {
    const E16 = 10n ** 16n
    const registered = {
      ...deposit("claimed"),
      netAmount: (75n * E16).toString(),
      fee: (425n * E16).toString(),
    }
    expect(depositRowAmount(registered, false)).toBe("+$0.75")
    expect(depositRowAmount(registered, false, 18, 375n * E16)).toBe("+$4.50")
  })
})

describe("depositRowStatusLabel", () => {
  it("leads with the recovery a deposit needs, over where it sits", () => {
    expect(depositRowStatusLabel(deposit("recoverable"))).toBe("Needs recovery")
  })

  it("names where a deposit still moving is, with a badge the row draws", () => {
    expect(depositRowStatusLabel(deposit("resolved"))).toBe("Awaiting funds")
    expect(depositRowStatusLabel(deposit("broadcast"))).toBe("Receiving")
    expect(depositRowStatusLabel(deposit("sweeping"))).toBe("Receiving")
    expect(depositRowStatusLabel(deposit("pendingClaim"))).toBe("Crediting")
    for (const phase of DEPOSIT_PHASES) {
      const label = depositRowStatusLabel(deposit(phase))
      if (label) expect(statusBadgeStyle(label), phase).toBeDefined()
    }
  })

  it("names each settled phase that never credited, and badges the one that did with nothing", () => {
    expect(depositRowStatusLabel(deposit("claimed"))).toBeUndefined()
    expect(depositRowStatusLabel(deposit("recovered"))).toBe("Recovered")
    expect(depositRowStatusLabel(deposit("failed"))).toBe("Deposit failed")
  })

  it("never contradicts the sheet: a badged phase reads the same word in both", () => {
    for (const phase of DEPOSIT_PHASES) {
      const row = depositRowStatusLabel(deposit(phase))
      if (!row) continue
      expect(depositStatus(deposit(phase)).label, phase).toBe(row)
    }
  })
})

describe("WITHDRAWAL_PHASE_LABEL", () => {
  it("shows one state from the burn to the payout, with a badge the row draws", () => {
    const releasing = ["l2_mined", "awaiting_proven", "finalizing_l1"] as const
    expect(releasing.map((phase) => WITHDRAWAL_PHASE_LABEL[phase])).toEqual([
      "Releasing",
      "Releasing",
      "Releasing",
    ])
    for (const phase of releasing) {
      expect(statusBadgeStyle(WITHDRAWAL_PHASE_LABEL[phase]!), phase).toBe("pending")
    }
  })

  it("separates the unmined burn, the failure, and the released withdrawal that shows nothing", () => {
    expect(WITHDRAWAL_PHASE_LABEL.done).toBeUndefined()
    expect(WITHDRAWAL_PHASE_LABEL.submitting).toBe("Pending")
    expect(WITHDRAWAL_PHASE_LABEL.failed).toBe("Failed")
  })
})

describe("upgradeRowStatusLabel", () => {
  const batch = (state: "sent" | "received"): ActivityItem =>
    ({
      kind: "upgrade.batch",
      batch: {
        run: "run",
        id: "remaining-0",
        recipient: "0xr",
        amount: "1",
        state,
        approved: true,
        startTime: 1,
      },
    } as ActivityItem)

  it("badges each step an unsettled upgrade shows", () => {
    for (const state of ["sent", "received"] as const) {
      const label = upgradeRowStatusLabel(upgradeRunsOf([batch(state)])[0]!)
      expect(label, state).toBeDefined()
      expect(statusBadgeStyle(label!), state).toBeDefined()
    }
  })
})

describe("a deposit's detail headline and gross", () => {
  const FUNDER = `0x${"f0".repeat(20)}` as Hex
  const WALLET = `0x${"a1".repeat(20)}` as Hex
  const FUNDING_TX = `0x${"e6".repeat(32)}` as Hex

  it("prefers the transfer's sender over the connected wallet, and names the wallet", () => {
    const sent = { ...deposit("funded"), walletName: " Rainbow ", walletAddress: WALLET }
    expect(depositHeadline(sent)).toEqual({ title: "Rainbow", address: WALLET })
    expect(depositHeadline({ ...sent, walletName: "  ", fundingFromAddress: FUNDER })).toEqual({
      title: undefined,
      address: FUNDER,
    })
  })

  it("takes a direct migration deposit's portal deposit as its funding tx", () => {
    const direct: SipaDeposit = {
      ...deposit("claimed", SWEEP_TX),
      direct: { recipientCommitment: `0x${"c0".repeat(32)}` },
    }
    expect(depositAttribution(direct).fundingTxHash).toBe(SWEEP_TX)
    expect(depositAttribution({ ...direct, fundingTxHash: FUNDING_TX }).fundingTxHash).toBe(
      FUNDING_TX,
    )
    expect(depositAttribution(deposit("claimed", SWEEP_TX)).fundingTxHash).toBeUndefined()
  })

  it("shows a stable in dollars and ETH in ETH, trimmed only on a row", () => {
    expect(depositGrossFigure(deposit("funded"))).toBe(usdFigure("18"))
    const eth: SipaDeposit = {
      ...deposit("funded"),
      amount: "0.123456789",
      tokenAddress: "0x0000000000000000000000000000000000000000",
    }
    expect(depositGrossFigure(eth)).toContain(eth.amount)
    expect(depositGrossFigure(eth)).toMatch(/ETH$/)
    expect(depositGrossFigure(eth, "row")).toBe(`${tokenAmount("0.123456789")} ETH`)
    expect(depositGrossFigure(eth, "row")).not.toBe(depositGrossFigure(eth))
  })
})
