import { describe, expect, it, vi } from "vitest"
import type { Address } from "viem"
import { SHARE } from "../../../src/core/services/savings/savingsMath"
import {
  TEST_SAVINGS_APY,
  readSavingsPrice,
} from "../../../src/core/services/savings/savingsPosition"

const VAULT = "0x00000000000000000000000000000000000000cc" as Address
/** The ray Sky publishes for a 5% rate. */
const SSR_5_PERCENT = 1000000001547125957863212448n
const MAINNET = 1
const SEPOLIA = 11155111

/** A vault whose share is worth 1.07 assets; `ssr` answers the rate given, or reverts like staging's mock. */
function vault(ssr?: bigint) {
  return {
    readContract: vi.fn(
      async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
        if (functionName === "convertToAssets") return ((args![0] as bigint) * 107n) / 100n
        if (ssr !== undefined) return ssr
        throw new Error("execution reverted")
      },
    ),
  }
}

describe("readSavingsPrice", () => {
  it("reads the share price at a price other than one, in two reads", async () => {
    const client = vault()
    const price = await readSavingsPrice(client as never, VAULT, { l1ChainId: MAINNET, now: 9 })
    expect(price).toEqual({ sharePrice: (107n * SHARE) / 100n, readAt: 9 })
    expect(client.readContract).toHaveBeenCalledTimes(2)
  })

  it("derives the rate the vault publishes", async () => {
    const price = await readSavingsPrice(vault(SSR_5_PERCENT) as never, VAULT, {
      l1ChainId: SEPOLIA,
    })
    expect(price.apy).toBeCloseTo(0.05, 4)
  })

  it("shows the test default off mainnet where the vault publishes no rate", async () => {
    const price = await readSavingsPrice(vault() as never, VAULT, {
      l1ChainId: SEPOLIA,
    })
    expect(price.apy).toBe(TEST_SAVINGS_APY)
  })

  it("shows no rate on mainnet where the vault publishes none, and where the chain is unknown", async () => {
    const mainnet = await readSavingsPrice(vault() as never, VAULT, {
      l1ChainId: MAINNET,
    })
    expect(mainnet.apy).toBeUndefined()
    const unknown = await readSavingsPrice(vault() as never, VAULT)
    expect(unknown.apy).toBeUndefined()
  })
})
