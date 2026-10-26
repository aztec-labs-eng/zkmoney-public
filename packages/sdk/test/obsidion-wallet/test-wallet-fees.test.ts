import { GasFees } from "@aztec-labs/stdlib/gas"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { describe, expect, it, vi } from "vitest"
import { stubNodeInfo } from "../utils/obsidionWalletStubs.js"

vi.mock("../../src/feePaymentMethod/sponsored_fpc.js", () => ({
  getSponsoredFeePaymentMethod: vi.fn(async () => ({ _stub: "sponsored" })),
}))

const { ObsidionWalletTest } = await import("../../src/obsidion/ObsidionWalletTest.js")

describe("ObsidionWalletTest sponsored fee default", () => {
  it("prices above the latest block's base fee when it sits over the min-fee floor", async () => {
    // A parallel suite's blocks raised the base fee past the floor; the node rejects a
    // simulation or tx whose max fee is below it.
    const node: any = {
      getNodeInfo: vi.fn(async () => stubNodeInfo()),
      getCurrentMinFees: vi.fn(async () => new GasFees(1, 10_200_000)),
      getBlockData: vi.fn(async () => ({
        header: { globalVariables: { gasFees: new GasFees(1, 10_400_000) } },
      })),
    }
    const wallet = new ObsidionWalletTest({} as any, node)

    const { gasSettings } = await (wallet as any).completeFeeOptions({
      from: await AztecAddress.random(),
      feePayer: undefined,
    })

    expect(gasSettings.maxFeesPerGas.feePerL2Gas).toBeGreaterThanOrEqual(10_400_000n)
  })
})
