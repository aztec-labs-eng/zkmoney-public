import { describe, expect, it } from "vitest"
import type { Hex } from "viem"
import type { WithdrawalRecord } from "../../../src/core/services/bridge/types"
import { withdrawalReleaseEta } from "../../../src/core/services/bridge/withdrawalReleaseEta"

const NOW = 1_700_000_000_000
const MIN = 60_000
const L2_TX = `0x${"0a".repeat(32)}` as Hex
/** Ten minutes from any landing. */
const release = () => 600
/** The relayer's pickup after the release is finalizable. */
const PICKUP = 120

const record = (
  phase: WithdrawalRecord["phase"],
  over: Partial<WithdrawalRecord> = {},
): Pick<
  WithdrawalRecord,
  "phase" | "l2TxHash" | "startTime" | "phaseEnteredAt" | "minedAt" | "reorgEpoch"
> => ({
  phase,
  l2TxHash: L2_TX,
  startTime: NOW - 20 * MIN,
  ...over,
})

describe("withdrawalReleaseEta", () => {
  it("is the typical wait from a landing now while the burn is still being mined, once sent", () => {
    expect(withdrawalReleaseEta(record("submitting"), release, NOW)).toEqual({
      seconds: 600 + PICKUP,
      remaining: false,
    })
    expect(withdrawalReleaseEta(record("submitting", { l2TxHash: undefined }), release, NOW)).toBe(
      undefined,
    )
  })

  it.each([
    ["l2_mined", { minedAt: NOW - 4 * MIN }],
    ["awaiting_proven", { minedAt: NOW - 4 * MIN, phaseEnteredAt: NOW - MIN }],
    ["awaiting_proven", { phaseEnteredAt: NOW - 4 * MIN }],
    ["l2_mined", { minedAt: NOW - 20 * MIN, phaseEnteredAt: NOW - 4 * MIN, reorgEpoch: 1 }],
  ] as const)(
    "counts down to the release from a %s burn's landing: minedAt, else the phase entry, which a reorg makes the landing again",
    (phase, over) => {
      expect(withdrawalReleaseEta(record(phase, over), release, NOW)).toEqual({
        seconds: 360 + PICKUP,
        remaining: true,
      })
    },
  )

  it("counts the relayer's pickup from the proof's sighting", () => {
    const proven = record("finalizing_l1", { minedAt: NOW - 10 * MIN, phaseEnteredAt: NOW - MIN })
    expect(withdrawalReleaseEta(proven, release, NOW)).toEqual({ seconds: 60, remaining: true })
  })

  it("has nothing once the wait ran out, or once the release is past", () => {
    const late = record("awaiting_proven", { minedAt: NOW - 30 * MIN })
    expect(withdrawalReleaseEta(late, release, NOW)).toBeUndefined()
    for (const phase of ["swapping", "done", "failed", "recoverable", "recovered"] as const)
      expect(withdrawalReleaseEta(record(phase), release, NOW)).toBeUndefined()
  })
})
