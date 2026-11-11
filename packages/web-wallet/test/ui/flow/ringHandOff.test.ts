// @vitest-environment node
import { describe, expect, it } from "vitest"
import { shownRing } from "../../../src/ui/flow/RingStage/ringHandOff"
import type { RingPhase } from "../../../src/ui/flow/RingLoader/RingLoader"

describe("ring hand-off", () => {
  it.each<[RingPhase, RingPhase, RingPhase]>([
    // Leaving bridging waits for the flip.
    ["bridging", "arriving", "bridging"],
    ["bridging", "arrived", "bridging"],
    ["bridging", "failed", "bridging"],
    // Leaving arriving waits for the breathe, unless it heads back to bridging.
    ["arriving", "arrived", "arriving"],
    ["arriving", "failed", "arriving"],
    ["arriving", "bridging", "bridging"],
    // A stopped ring takes the next phase at once.
    ["arrived", "bridging", "bridging"],
    ["failed", "arriving", "arriving"],
    ["arriving", "arriving", "arriving"],
  ])("landed on %s, heading to %s, shows %s", (landed, target, shown) => {
    expect(shownRing(landed, target)).toBe(shown)
  })
})
