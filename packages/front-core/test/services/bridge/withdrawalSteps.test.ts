import { describe, expect, it } from "vitest"
import {
  WITHDRAWAL_STEPS,
  withdrawalStepIndex,
  withdrawalSteps,
} from "../../../src/core/services/bridge/withdrawalSteps"
import { WITHDRAWAL_PHASE_COPY } from "../../../src/core/services/bridge/withdrawalCopy"
import type { WithdrawalPhase } from "../../../src/core/services/bridge/types"

const PHASES = Object.keys(WITHDRAWAL_PHASE_COPY) as WithdrawalPhase[]

describe("withdrawal ladder", () => {
  it("shows one rung from the burn landing until the funds reach Ethereum", () => {
    expect(WITHDRAWAL_STEPS.map((s) => s.label)).toEqual([
      "Sent on Aztec",
      "Releasing to Ethereum",
      "Paid",
    ])
    const phases: WithdrawalPhase[] = ["submitting", "l2_mined", "awaiting_proven", "finalizing_l1"]
    expect(phases.map((p) => withdrawalStepIndex(p))).toEqual([0, 1, 1, 1])
  })

  it("adds the swap before the payout on a swap-on-withdraw", () => {
    expect(withdrawalSteps(true).map((s) => s.label)).toEqual([
      "Sent on Aztec",
      "Releasing to Ethereum",
      "Swapping",
      "Paid",
    ])
    expect(withdrawalStepIndex("swapping", true)).toBe(2)
    expect(withdrawalStepIndex("recoverable", true)).toBe(2)
  })

  it("puts `done` and `recovered` past the last rung so every rung reads complete", () => {
    expect(withdrawalStepIndex("done")).toBe(WITHDRAWAL_STEPS.length)
    expect(withdrawalStepIndex("recovered", true)).toBe(withdrawalSteps(true).length)
  })

  it("parks `failed` inside the ladder", () => {
    expect(withdrawalStepIndex("failed")).toBeLessThan(WITHDRAWAL_STEPS.length)
  })
})

describe("withdrawal copy", () => {
  // "Proven", "finalized" and "proving" read as the proof the device makes; the wait on Ethereum
  // must never use them.
  it("never names the wait on Ethereum after a proof", () => {
    const shown = [
      ...PHASES.flatMap((p) => Object.values(WITHDRAWAL_PHASE_COPY[p])),
      ...withdrawalSteps(true).map((s) => s.label),
    ].filter((word): word is string => typeof word === "string")
    const localProof = WITHDRAWAL_PHASE_COPY.submitting.proving
    for (const word of shown.filter((w) => w !== localProof)) {
      expect(word).not.toMatch(/prov|finali/i)
    }
  })
})
