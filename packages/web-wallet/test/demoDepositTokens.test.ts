/**
 * Demo mode shows the mainnet token shape whatever network it booted on, so the picker and the
 * per-token rows behind it are reviewable offline.
 */
import { describe, expect, it, vi } from "vitest"
import { Network } from "@obsidion/sdk"
import { resetDemoFlagForTests } from "../src/dev/demoFlag"

vi.mock("../src/config/env", () => ({ getConfig: () => ({ network: "sandbox" }) }))

const { depositTokensFor } = await import("../src/features/deposit/loadDepositFacts")

/** Latches ?demo=<scenario> for the callback, then restores a clean flag. */
function inDemoMode<T>(run: () => T): T {
  window.history.replaceState({}, "", "/?demo=activity")
  resetDemoFlagForTests()
  try {
    return run()
  } finally {
    window.history.replaceState({}, "", "/")
    sessionStorage.removeItem("webwallet.demo")
    resetDemoFlagForTests()
  }
}

describe("depositTokensFor", () => {
  it("offers only the manifest token off mainnet", () => {
    expect(depositTokensFor(Network.SANDBOX).map((t) => t.symbol)).toEqual(["TEST"])
  })

  it("offers the mainnet swap set in a demo, whatever network it booted on", () => {
    const tokens = inDemoMode(() => depositTokensFor(Network.SANDBOX))

    expect(tokens.map((t) => t.symbol)).toEqual(
      depositTokensFor(Network.MAINNET).map((t) => t.symbol),
    )
    expect(tokens.map((t) => t.decimals)).toEqual([18, 6, 6])
    // The first entry is the manifest token the pool settles in, so it carries no address.
    expect(tokens[0]!.address).toBeUndefined()
    expect(tokens.every((t) => !!t.icon)).toBe(true)
  })
})
