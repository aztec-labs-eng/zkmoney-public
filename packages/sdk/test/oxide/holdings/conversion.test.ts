import { describe, expect, it } from "vitest"
import type { Step } from "@oxide/l1-contracts/multi_step/index.js"
import { bindConversion, conversionAdapters } from "../../../src/oxide/holdings/conversion.js"
import { CONVERSION_ADAPTERS } from "../../../src/oxide/holdings/conversions/index.js"
import {
  DAI,
  DAI_VAULT,
  SKY_CONVERTER_ADAPTER,
  USDS,
  USDS_VAULT,
  fakeChain,
  vaultHolding,
} from "./holdingFixtures.js"

const shape = (steps: Step[]) => steps.map((step) => [step.adapter, step.fn, step.in, step.out])

describe("bindConversion", () => {
  it("binds no conversion to no steps, at par", async () => {
    const none = await bindConversion(
      CONVERSION_ADAPTERS,
      fakeChain(DAI),
      vaultHolding("None"),
      DAI_VAULT,
    )
    expect([none.steps("in", 5n), none.steps("out", 5n)]).toEqual([[], []])
    expect(await none.quote("in", 5n)).toEqual({ out: 5n, fee: 0n, minOut: 5n })
  })

  it("binds DaiUsds to the executor's converter, both ways, at par", async () => {
    const { steps, quote } = await bindConversion(
      CONVERSION_ADAPTERS,
      fakeChain(),
      vaultHolding("DaiUsds"),
      USDS_VAULT,
    )
    expect({ in: shape(steps("in", 5n)), out: shape(steps("out", 5n)) }).toEqual({
      in: [[SKY_CONVERTER_ADAPTER, "daiToUsds", DAI, USDS]],
      out: [[SKY_CONVERTER_ADAPTER, "usdsToDai", USDS, DAI]],
    })
    expect(await quote("out", 5n)).toEqual({ out: 5n, fee: 0n, minOut: 5n })
  })

  it("refuses a converter that swaps other tokens than the holding's", async () => {
    const chain = fakeChain(USDS, { dai: DAI, usds: DAI })
    await expect(
      bindConversion(CONVERSION_ADAPTERS, chain, vaultHolding("DaiUsds"), USDS_VAULT),
    ).rejects.toMatchObject({ code: "move.routeMismatch" })
  })

  it("refuses a conversion no adapter routes", async () => {
    await expect(
      bindConversion(conversionAdapters(), fakeChain(), vaultHolding("None"), DAI_VAULT),
    ).rejects.toMatchObject({ code: "holding.unsupported" })
  })
})
