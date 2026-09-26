/**
 * The status a bridge record shows on its feed row and in its detail modal. The sheet names each
 * in-flight phase; the row collapses them to Pending so the design-system badge still draws. What
 * is pinned is that a row and its sheet never contradict on the phases the row names outright
 * (Needs recovery / Recovered / Canceled), plus the withdrawal legs that wait on the same thing.
 */
import { describe, expect, it } from "vitest"
import type { Hex } from "viem"
import type { SIPADepositPhase, SIPADepositRecord } from "@obsidion/front-core"
import { depositRowStatusLabel } from "../src/ui/screens/activityView"
import { depositStatus } from "../src/ui/screens/DepositDetailModal"
import { statusBadgeStyle } from "@obsidion/web-ds"
import { WITHDRAWAL_PHASE_LABEL } from "../src/ui/screens/useActivityEntries"

const SWEEP_TX = `0x${"5e".repeat(32)}` as Hex

const deposit = (phase: SIPADepositPhase, sweepTxHash?: Hex): SIPADepositRecord =>
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
  } as SIPADepositRecord)

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

  it("does not imply a sweep transaction exists until its hash is known", () => {
    expect(depositStatus(deposit("sweeping")).label).toBe("Waiting to be swept")
    expect(depositStatus(deposit("sweeping", SWEEP_TX)).label).toBe("Sweeping into Aztec")
  })

  it("uses Figma's Completed / Canceled on the terminal phases the sheet draws", () => {
    expect(depositStatus(deposit("claimed")).label).toBe("Completed")
    expect(depositStatus(deposit("failed")).label).toBe("Cancelled")
  })

  it("hands every phase a record can hold both a label and a badge", () => {
    for (const phase of DEPOSIT_PHASES) {
      const status = depositStatus(deposit(phase))
      expect(status.label, phase).toBeTruthy()
      expect(status.badge, phase).toBeTruthy()
    }
  })
})

describe("depositRowStatusLabel", () => {
  it("leads with the recovery a deposit needs, over where it sits", () => {
    expect(depositRowStatusLabel(deposit("recoverable"))).toBe("Needs recovery")
  })

  it("calls everything still moving pending", () => {
    for (const phase of ["broadcast", "sweeping", "pendingClaim"] as const) {
      expect(depositRowStatusLabel(deposit(phase)), phase).toBe("Pending")
    }
  })

  it("names each settled phase that never credited, and badges the one that did with nothing", () => {
    expect(depositRowStatusLabel(deposit("claimed"))).toBeUndefined()
    expect(depositRowStatusLabel(deposit("recovered"))).toBe("Recovered")
    expect(depositRowStatusLabel(deposit("failed"))).toBe("Cancelled")
  })

  it("never contradicts the sheet: a badged phase reads the same word in both", () => {
    // The sheet refines the row on in-flight phases (a named step under Pending), so what has to
    // match is every phase the row names outright.
    for (const phase of DEPOSIT_PHASES) {
      const row = depositRowStatusLabel(deposit(phase))
      if (!row || row === "Pending") continue
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
