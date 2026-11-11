// @vitest-environment node
import { describe, expect, it } from "vitest"
import type { SIPADepositPhase } from "@obsidion/core/types"
import { sentDepositStage } from "../../../src/features/deposit/DepositSentStatus/DepositSentStatus"

const view = (phase: SIPADepositPhase) => ({
  phase,
  coin: "USDC",
  sent: "500 USDC",
  landing: "499.15 USDC",
  arrived: "499.15 USDC",
  wallet: "MetaMask",
  network: "Ethereum",
})

describe("sent deposit stage", () => {
  it.each<[SIPADepositPhase, string, string]>([
    ["resolved", "bridging", "sending"],
    ["funding", "bridging", "sending"],
    ["funded", "arriving", "arriving"],
    ["broadcast", "arriving", "arriving"],
    ["sweeping", "arriving", "arriving"],
    ["pendingClaim", "arriving", "arriving"],
    ["claimed", "arrived", "arrived"],
    ["failed", "failed", "failed"],
  ])("shows %s on the %s ring with its own block", (phase, ring, active) => {
    const stage = sentDepositStage(view(phase), () => {})
    expect(stage.ring).toBe(ring)
    expect(stage.active).toBe(active)
    expect(stage.blocks.map((b) => b.key)).toContain(active)
  })
})
