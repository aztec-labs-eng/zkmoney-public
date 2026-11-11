// @vitest-environment node
/** After a ceremony gate, only a speed picked while it was open replaces the one the tap noted. */
import { describe, expect, it } from "vitest"
import { afterGate, type SpeedDecision } from "../../../src/features/paylink/registrationProverTip"

const noted: SpeedDecision = { tip: 0n, speed: "standard", picks: 1 }

describe("afterGate", () => {
  it("keeps the noted decision when the gate shows nothing new", () => {
    expect(afterGate(noted, undefined)).toBe(noted)
    expect(afterGate(noted, { tip: 5n, speed: "faster", picks: 1 })).toBe(noted)
  })

  it("takes the shown decision once the user picked again", () => {
    const shown: SpeedDecision = { tip: 5n, speed: "faster", picks: 2 }
    expect(afterGate(noted, shown)).toBe(shown)
    expect(afterGate(undefined, shown)).toBe(shown)
  })
})
