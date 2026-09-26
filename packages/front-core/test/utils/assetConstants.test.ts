import { describe, expect, it } from "vitest"
import { Network } from "@obsidion/sdk"
import { resolveAssetConstants } from "../../src/utils"

describe("resolveAssetConstants", () => {
  it("returns 18-decimal DAI on sandbox", () => {
    expect(resolveAssetConstants(Network.SANDBOX).DAI.decimals).toBe(18)
  })

  it("returns 18-decimal DAI on testnet", () => {
    expect(resolveAssetConstants(Network.TESTNET).DAI.decimals).toBe(18)
  })

  it("keeps the ANY fallback at DEFAULT_DECIMALS across networks", () => {
    expect(resolveAssetConstants(Network.SANDBOX).ANY.decimals).toBe(18)
    expect(resolveAssetConstants(Network.TESTNET).ANY.decimals).toBe(18)
  })
})
