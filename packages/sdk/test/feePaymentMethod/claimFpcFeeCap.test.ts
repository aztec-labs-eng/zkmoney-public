/**
 * The open policy's fee limit: caps + entrypoint overhead at 1e13 per gas, over the declared caps.
 * With DA at 0 that is ~1.222e13 per L2 gas declared, i.e. a min fee of ~8.15e12 after the 1.5x pad.
 */
import { describe, expect, it } from "vitest"
import { GasFees } from "@aztec/stdlib/gas"
import { claimFpcOpenBatchWithinCap } from "../../src/feePaymentMethod/claimFpcBatchGas.js"

const padded = (minFeePerL2Gas: bigint) => new GasFees(0n, (minFeePerL2Gas * 3n) / 2n)

describe("claimFpcOpenBatchWithinCap", () => {
  it("passes below the overhead-adjusted limit, though above the bare 1e13 config price", () => {
    expect(claimFpcOpenBatchWithinCap(padded(8_100_000_000_000n))).toBe(true)
  })

  it("refuses the 2026-10-08 mainnet min fee", () => {
    expect(claimFpcOpenBatchWithinCap(padded(8_326_112_736_907n))).toBe(false)
  })
})
