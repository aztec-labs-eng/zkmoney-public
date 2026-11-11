// @vitest-environment node
/** An upgrade's batch tells waiting for approval from approved and from releasing. */
import { upgradeRunsOf, type UpgradeBatchItem } from "@obsidion/front-core"
import { describe, expect, it } from "vitest"
import { legStatus } from "../../../src/ui/screens/UpgradeRunDetailModal"

const batch = (
  id: string,
  recipient: string,
  state: UpgradeBatchItem["state"],
  approved = true,
) => ({
  kind: "upgrade.batch" as const,
  batch: { run: "run", id, recipient, amount: "10", state, approved, startTime: 1_000 },
})
const legOf = (state: UpgradeBatchItem["state"], approved = true) =>
  upgradeRunsOf([
    batch("remaining-0", "0xa1", "sent"),
    batch("remaining-1", "0xb2", state, approved),
  ])[0]!.legs[1]!

describe("legStatus", () => {
  it("gives a planned batch's approval and its release each their own step", () => {
    const labels = [legOf("planned", false), legOf("planned"), legOf("sent")].map(
      (leg) => legStatus(leg).label,
    )
    expect(new Set(labels).size).toBe(3)
  })
})
