import type { RingPhase } from "../RingLoader/RingLoader"

/**
 * The phase the ring shows while heading to `target` from the phase its motion last `landed` on.
 * Leaving bridging waits for the flip to land; leaving arriving, but not for bridging, the breathe.
 */
export function shownRing(landed: RingPhase, target: RingPhase): RingPhase {
  const holds = landed === "bridging" || (landed === "arriving" && target !== "bridging")
  return holds ? landed : target
}
