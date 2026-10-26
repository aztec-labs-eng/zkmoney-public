import { describe, expect, it } from "vitest"
import type { WithdrawalRecord } from "../../../src/core/services/bridge/types"
import {
  savingsMoveEta,
  type SavingsMoveTiming,
} from "../../../src/core/services/savings/savingsMoveEta"

const NOW = 1_700_000_000_000
/** A 36 s slot grid, and a release ten minutes after the landing. */
const timing: SavingsMoveTiming = {
  grid: { l1GenesisTime: 0, slotDuration: 36 },
  releaseSeconds: () => 600,
}
// The deposit arrival chain from a release at `at`: pickup 120 s, the next slot, the sync tick, the claim and one slot.
const arrival = (at: number) => {
  const sweepAt = at + 120
  const availableAt = (Math.floor(sweepAt / 36) + 1) * 36
  return availableAt + 12 + 60 + 36 - at
}
const move = (extra = {}) => ({ startTime: NOW - 20 * 60_000, ...extra })
const burn = (phase: WithdrawalRecord["phase"], extra: Partial<WithdrawalRecord> = {}) =>
  ({ phase, startTime: NOW - 20 * 60_000, ...extra } as WithdrawalRecord)

describe("savingsMoveEta", () => {
  it("gives the whole typical journey while the burn still proves on the device", () => {
    const eta = savingsMoveEta(move(), burn("submitting"), timing, NOW)
    expect(eta).toEqual({ seconds: 600 + arrival(NOW / 1000 + 600), remaining: false })
  })

  it("counts down from the burn's landing through the release, the escrow and the deposit", () => {
    const landedAt = NOW - 4 * 60_000
    const eta = savingsMoveEta(
      move(),
      burn("awaiting_proven", { phaseEnteredAt: landedAt }),
      timing,
      NOW,
    )
    const releaseAt = landedAt / 1000 + 600
    expect(eta).toEqual({ seconds: releaseAt + arrival(releaseAt) - NOW / 1000, remaining: true })
    expect(eta!.seconds).toBeLessThan(600 + 6 * 60)
  })

  it("counts down from the release once the burn is out, and from the proof while the relayer releases it", () => {
    const releasedAt = NOW - 60_000
    expect(savingsMoveEta(move(), burn("done", { endTime: releasedAt }), timing, NOW)).toEqual({
      seconds: releasedAt / 1000 + arrival(releasedAt / 1000) - NOW / 1000,
      remaining: true,
    })
    const provenAt = NOW - 30_000
    const proven = savingsMoveEta(
      move(),
      burn("finalizing_l1", { phaseEnteredAt: provenAt }),
      timing,
      NOW,
    )
    expect(proven?.remaining).toBe(true)
    expect(proven!.seconds).toBeGreaterThan(arrival(provenAt / 1000 + 120) - 30)
  })

  it("gives the typical rest once the deposit is found, nothing once claimed, failed or overdue", () => {
    const found = savingsMoveEta(
      move({ deposit: { inboxIndex: "1", amount: "2", claimed: false } }),
      burn("done", { endTime: NOW - 60_000 }),
      timing,
      NOW,
    )
    expect(found?.remaining).toBe(false)
    expect(found!.seconds).toBeLessThan(arrival(NOW / 1000))
    expect(
      savingsMoveEta(
        move({ deposit: { inboxIndex: "1", amount: "2", claimed: true } }),
        burn("done"),
        timing,
        NOW,
      ),
    ).toBeUndefined()
    expect(savingsMoveEta(move(), burn("failed"), timing, NOW)).toBeUndefined()
    expect(
      savingsMoveEta(move(), burn("done", { endTime: NOW - 60 * 60_000 }), timing, NOW),
    ).toBeUndefined()
  })
})
