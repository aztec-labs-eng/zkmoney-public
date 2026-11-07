// @vitest-environment node
// What the registration deposit's detail offers, over the record and what reached the address.
import { describe, expect, it } from "vitest"
import type { PendingRegistrationRecord, RegistrationStage } from "@obsidion/front-core"
import { registrationDepositState } from "../../../../src/features/onboarding/RegistrationDepositDetailModal/registrationDepositState"
import { pendingRecord } from "../../../support/registrationFixtures"
import { RANDOM } from "../../../support/registrationPrices"

const record = pendingRecord({ broadcast: false })
const nothing = { depositAdmitted: false, refunded: false, seen: 0n }
const short = BigInt(RANDOM.fee) + 1n

describe("the deposit detail", () => {
  it.each<[RegistrationStage, boolean, boolean]>([
    // stage, publishing, funding open
    ["reserved", false, true],
    ["funding", false, false],
    ["received", true, false],
    ["sweeping", true, false],
    ["registered", false, false],
  ])("at %s", (stage, publishing, fundingOpen) => {
    expect(registrationDepositState(record, null, stage, nothing)).toEqual({
      needsRefund: false,
      publishing,
      fundingOpen,
    })
  })

  it("waits on the stage", () => {
    expect(registrationDepositState(record, null, undefined, nothing)).toEqual({
      needsRefund: false,
      publishing: false,
      fundingOpen: false,
    })
  })

  it("publishes nothing for an address already published, swept or closed", () => {
    for (const over of [
      { broadcast: true },
      { sweptAt: 1 },
      { phase: "failed_terminal" },
      { replaced: { sipaAddress: record.sipaAddress, refunded: false, broadcastSpent: true } },
    ] satisfies Partial<PendingRegistrationRecord>[])
      expect(
        registrationDepositState(
          pendingRecord({ broadcast: false, ...over }),
          null,
          "received",
          nothing,
        ).publishing,
      ).toBe(false)
  })

  it("offers the refund, not the pay block, for a reached deposit its fee cannot sweep", () => {
    const refunded = { depositAdmitted: false, refunded: true, seen: 0n }
    expect(registrationDepositState(record, null, "reserved", refunded, short)).toEqual({
      needsRefund: true,
      publishing: false,
      fundingOpen: false,
    })
    expect(registrationDepositState(record, null, "received", refunded, short).publishing).toBe(
      false,
    )
    expect(registrationDepositState(record, null, "reserved", nothing, short).needsRefund).toBe(
      false,
    )
  })

  it("closes the pay block once the deposit is admitted", () => {
    const admitted = { depositAdmitted: true, refunded: false, seen: 0n }
    expect(registrationDepositState(record, null, "reserved", admitted)).toMatchObject({
      needsRefund: false,
      fundingOpen: false,
    })
  })
})
